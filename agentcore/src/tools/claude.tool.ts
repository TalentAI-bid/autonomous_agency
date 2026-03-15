import { complete as bedrockComplete, SMART_MODEL } from './together-ai.tool.js';

/**
 * High-quality text generation using the smart model (GPT-OSS-120B on Bedrock).
 * Used by outreach + reply agents for email generation.
 */
export async function complete(
  tenantId: string,
  systemPrompt: string,
  userPrompt: string,
  opts?: { max_tokens?: number },
): Promise<string> {
  return bedrockComplete(tenantId, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], { max_tokens: opts?.max_tokens ?? 4096, model: SMART_MODEL });
}
