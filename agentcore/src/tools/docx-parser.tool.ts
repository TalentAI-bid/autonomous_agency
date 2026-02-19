import mammoth from 'mammoth';
import logger from '../utils/logger.js';

export interface DocxResult {
  text: string;
}

export async function parseDOCX(buffer: Buffer): Promise<DocxResult> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value };
  } catch (err) {
    logger.error({ err }, 'DOCX parse error');
    return { text: '' };
  }
}
