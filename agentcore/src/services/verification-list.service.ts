import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { extractJSON } from '../tools/together-ai.tool.js';
import logger from '../utils/logger.js';

// ── Company-list upload parsing + ingestion (list_verification mode) ─────────
// Shared by the master-agent upload route and the setup-chat file handler so
// there's a single source of truth for how an uploaded CSV/Excel becomes a
// verification list.

export interface ParsedListEntry {
  name: string;
  sourceUrl?: string;
  notes?: string;
}

export interface VerificationListItem {
  companyId: string;
  name: string;
  sourceUrl?: string;
  notes?: string;
}

const SPREADSHEET_EXTS = ['csv', 'xlsx', 'xls'];
const SPREADSHEET_MIME_RE = /csv|excel|spreadsheet|officedocument\.spreadsheet/i;

/** True when a filename/mimetype looks like a CSV or Excel workbook. */
export function isSpreadsheetFile(fileName: string, mimeType: string): boolean {
  const ext = (fileName.toLowerCase().split('.').pop() ?? '').trim();
  if (SPREADSHEET_EXTS.includes(ext)) return true;
  return SPREADSHEET_MIME_RE.test(mimeType ?? '');
}

/** Coerce an ExcelJS cell value (string, number, hyperlink object, richtext) to plain text. */
function cellToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text.trim();
    if (typeof o.hyperlink === 'string') return o.hyperlink.trim();
    if (typeof o.result === 'string') return o.result.trim();
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('').trim();
  }
  return String(v).trim();
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const LIST_URL_RE = /https?:\/\/[^\s,;]+/i;

/** Header-keyword heuristic — fallback when the LLM column picker is unavailable. */
function heuristicNameColumn(headers: string[]): number {
  const idx = headers.findIndex((h) => /soci[ée]t|company|entreprise|client|\bnom\b|\bname\b|raison/.test(h ?? ''));
  return idx >= 1 ? idx : 1; // fallback: first column
}

/**
 * Ask the LLM which 1-based columns hold the company NAME / URL / notes, given
 * the headers + a few sample rows. The model only returns column INDICES — it
 * never emits names, so it cannot invent companies. Returns null on any
 * failure so the caller falls back to the heuristic.
 */
async function detectColumnsViaLLM(
  tenantId: string,
  headers: string[],
  sampleRows: string[][],
  colCount: number,
): Promise<{ nameColumn: number; urlColumn?: number; notesColumn?: number } | null> {
  try {
    const colLines: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      const samples = sampleRows.map((r) => r[c] ?? '').filter((v) => v && v.length > 0).slice(0, 5);
      colLines.push(`${c}. header="${headers[c] ?? ''}" samples=${JSON.stringify(samples)}`);
    }
    const messages = [
      {
        role: 'system' as const,
        content:
          'You identify columns in a spreadsheet of companies. Reply with JSON only. '
          + 'You must NOT generate, guess, or invent any company names — you only return column index numbers.',
      },
      {
        role: 'user' as const,
        content:
          `Spreadsheet columns (1-based):\n${colLines.join('\n')}\n\n`
          + 'Return JSON: {"nameColumn": <int>, "urlColumn": <int|null>, "notesColumn": <int|null>}.\n'
          + '- nameColumn = the column holding the real COMPANY / ORGANIZATION NAMES '
          + '(e.g. "AB INJECT", "Bontaz"). It is NOT a code/ID column (values like "U01","T06","C05"), '
          + 'NOT a category/activity column, NOT notes, NOT a URL column.\n'
          + '- urlColumn = a column of http(s) links, or null.\n'
          + '- notesColumn = a free-text notes/comment column, or null.\n'
          + 'Return ONLY the JSON object with integer indices.',
      },
    ];
    const out = await extractJSON<{ nameColumn?: number; urlColumn?: number | null; notesColumn?: number | null }>(
      tenantId,
      messages,
      2,
      { temperature: 0 },
    );
    const nameColumn = Number(out?.nameColumn);
    if (!Number.isInteger(nameColumn) || nameColumn < 1 || nameColumn > colCount) return null;
    const valid = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= colCount ? n : undefined;
    };
    return { nameColumn, urlColumn: valid(out?.urlColumn), notesColumn: valid(out?.notesColumn) };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'verification-list: LLM column detection failed — using heuristic');
    return null;
  }
}

/**
 * Parse an uploaded .csv/.xlsx into company entries. No fixed template: an LLM
 * identifies WHICH column holds the real company names (plus optional URL /
 * notes columns) from the headers + sample rows; we then extract the actual
 * cell values from that column deterministically. The LLM only picks column
 * indices — it never produces names, so nothing is invented. Falls back to a
 * header-keyword heuristic if the LLM is unavailable.
 */
export async function parseCompanyListFile(
  tenantId: string,
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<ParsedListEntry[]> {
  const isCsv = /\.csv$/i.test(filename) || /csv|text\/plain/i.test(mimetype);
  const workbook = new ExcelJS.Workbook();
  if (isCsv) {
    await workbook.csv.read(Readable.from(buffer.toString('utf-8')));
  } else {
    await workbook.xlsx.load(buffer as any);
  }
  const ws = workbook.worksheets[0];
  if (!ws) return [];

  // Raw headers (for the LLM) + normalized (for the heuristic fallback).
  const rawHeaders: string[] = [];
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    rawHeaders[col] = cellToString(cell.value);
    headers[col] = normalizeHeader(cellToString(cell.value));
  });
  const colCount = Math.max(rawHeaders.length - 1, headers.length - 1, 0);

  // First few data rows as a sample for the LLM (1-based column slots).
  const sampleRows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1 || sampleRows.length >= 5) return;
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col] = cellToString(cell.value); });
    sampleRows.push(cells);
  });

  const detected = await detectColumnsViaLLM(tenantId, rawHeaders, sampleRows, colCount);
  const nameIdx = detected?.nameColumn ?? heuristicNameColumn(headers);
  const urlIdx = detected?.urlColumn;
  const notesIdx = detected?.notesColumn ?? headers.findIndex((h) => /note/.test(h ?? ''));
  logger.info(
    { nameIdx, urlIdx, notesIdx, viaLLM: !!detected, colCount },
    'verification-list: resolved columns',
  );

  const entries: ParsedListEntry[] = [];
  const seen = new Set<string>();
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const name = cellToString(row.getCell(nameIdx).value);
    if (!name || name.length < 2) return;
    const dedupKey = name.toLowerCase();
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);

    // Prefer the detected URL column; else scan the row for any http(s) link.
    let sourceUrl: string | undefined;
    if (urlIdx && urlIdx > 0) {
      const m = cellToString(row.getCell(urlIdx).value).match(LIST_URL_RE);
      if (m) sourceUrl = m[0];
    }
    if (!sourceUrl) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (sourceUrl) return;
        const m = cellToString(cell.value).match(LIST_URL_RE);
        if (m) sourceUrl = m[0];
      });
    }
    const notes = notesIdx && notesIdx > 0 ? cellToString(row.getCell(notesIdx).value) : '';
    entries.push({ name, sourceUrl, notes: notes || undefined });
  });
  return entries;
}

/**
 * Pre-create one company row per parsed entry (source='user_list') under the
 * given master agent and return the verification list to store on
 * `config.verificationList`. Rows that fail validation are skipped.
 */
export async function buildVerificationList(
  tenantId: string,
  masterAgentId: string,
  entries: ParsedListEntry[],
): Promise<VerificationListItem[]> {
  const list: VerificationListItem[] = [];
  for (const e of entries) {
    try {
      const company = await saveOrUpdateCompanyStatic(
        tenantId,
        {
          name: e.name,
          rawData: { source: 'user_list', listEntry: true, sourceUrl: e.sourceUrl ?? null, notes: e.notes ?? null },
        },
        masterAgentId,
      );
      list.push({ companyId: company.id, name: e.name, sourceUrl: e.sourceUrl, notes: e.notes });
    } catch (err) {
      logger.warn({ err, name: e.name }, 'verification-list: skipped invalid company');
    }
  }
  return list;
}

/** Default decision-maker titles for the LinkedIn team scrape in this mode. */
export const DEFAULT_TEAM_ROLE_KEYWORDS = ['CEO', 'founder', 'sales', 'marketing'];
