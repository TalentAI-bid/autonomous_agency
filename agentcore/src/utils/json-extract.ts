/**
 * Robust JSON extraction from LLM responses.
 *
 * Handles: <think> blocks, code fences, balanced brace/bracket matching,
 * trailing commas, and mixed prose+JSON output.
 */

export class JSONExtractionError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'JSONExtractionError';
  }
}

/**
 * Extract and parse a JSON value from arbitrary LLM text.
 *
 * Strategy order:
 * 1. Strip `<think>...</think>` blocks (DeepSeek R1)
 * 2. Direct `JSON.parse` on trimmed text
 * 3. Code-fence extraction (```json, ```, ~~~json, ~~~)
 * 4. Balanced brace/bracket scanning
 * 5. Trailing-comma cleanup + re-parse
 */
export function extractJSONFromText<T = unknown>(text: string): T {
  if (!text || !text.trim()) {
    throw new JSONExtractionError('Empty input', text ?? '');
  }

  // 1. Strip <think>...</think> blocks
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // 2. Direct parse
  try {
    return JSON.parse(cleaned) as T;
  } catch { /* continue */ }

  // 3. Code-fence extraction — try multiple fence patterns
  const fencePatterns = [
    /```json\s*([\s\S]*?)```/,
    /```\s*([\s\S]*?)```/,
    /~~~json\s*([\s\S]*?)~~~/,
    /~~~\s*([\s\S]*?)~~~/,
  ];
  for (const pattern of fencePatterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      try {
        return JSON.parse(match[1].trim()) as T;
      } catch { /* try next pattern */ }
    }
  }

  // 4. Balanced brace/bracket scanning
  const balanced = extractBalancedJSON(cleaned);
  if (balanced !== null) {
    try {
      return JSON.parse(balanced) as T;
    } catch { /* continue to trailing-comma cleanup */ }

    // 5. Trailing-comma cleanup on the balanced extraction
    const noTrailingCommas = balanced
      .replace(/,\s*([\]}])/g, '$1');
    try {
      return JSON.parse(noTrailingCommas) as T;
    } catch { /* fall through */ }
  }

  // 5b. Trailing-comma cleanup on the whole cleaned text (fallback)
  const firstBrace = cleaned.search(/[\[{]/);
  if (firstBrace !== -1) {
    const lastBrace = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
    if (lastBrace > firstBrace) {
      const slice = cleaned.slice(firstBrace, lastBrace + 1);
      const noTrailingCommas = slice.replace(/,\s*([\]}])/g, '$1');
      try {
        return JSON.parse(noTrailingCommas) as T;
      } catch { /* fall through */ }
    }
  }

  throw new JSONExtractionError(
    `Failed to extract valid JSON from LLM response (length=${text.length})`,
    text.slice(0, 500),
  );
}

/**
 * Scan for the first `{` or `[` and find its balanced closing counterpart,
 * tracking depth and respecting JSON string literals.
 */
function extractBalancedJSON(text: string): string | null {
  const startIdx = text.search(/[\[{]/);
  if (startIdx === -1) return null;

  const openChar = text[startIdx]!;
  const closeChar = openChar === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && ch === closeChar) {
        return text.slice(startIdx, i + 1);
      }
    }
  }

  // Depth never reached 0 — truncated JSON. Return best-effort slice to last matching char.
  const lastClose = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (lastClose > startIdx) {
    return text.slice(startIdx, lastClose + 1);
  }

  return null;
}
