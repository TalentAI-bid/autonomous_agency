import { PDFParse } from 'pdf-parse';
import logger from '../utils/logger.js';

export interface PDFResult {
  text: string;
  pages: number;
}

export async function parsePDF(buffer: Buffer): Promise<PDFResult> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return { text: result.text, pages: result.pages.length };
  } catch (err) {
    logger.error({ err }, 'PDF parse error');
    return { text: '', pages: 0 };
  }
}
