import { withTenant } from '../config/database.js';
import { pipelineErrors } from '../db/schema/pipeline-errors.js';
import { pubRedis } from '../queues/setup.js';
import logger from './logger.js';

export const ERROR_MESSAGES: Record<string, { message: string; retryable: boolean }> = {
  cloudflare_block:    { message: 'LinkedIn blocked the server. Retry in a few hours or use the extension.', retryable: true },
  crawl_timeout:       { message: 'Page took too long to load. The site may be slow or down.',               retryable: true },
  parse_failure:       { message: 'Could not extract data from the page. The page layout may have changed.', retryable: false },
  linkedin_rate_limit: { message: 'LinkedIn rate limited the extension. Pausing for 1 hour.',                retryable: true },
  linkedin_popup:      { message: 'LinkedIn showed a popup. Dismiss it in Chrome and click Resume.',         retryable: true },
  invalid_domain:      { message: "Company's website domain does not exist.",                                retryable: false },
  scrape_failed:       { message: 'Could not scrape the company website.',                                   retryable: true },
  empty_response:      { message: 'The page returned no content.',                                           retryable: true },
  no_job_posts_found:  { message: 'No matching job posts found for these keywords.',                         retryable: false },
  wrong_tool:          { message: 'Pipeline dispatched the wrong tool (expected LinkedIn Jobs, got job board). Check strategist output.', retryable: false },
};

export interface LogPipelineErrorInput {
  tenantId: string;
  masterAgentId?: string | null;
  step: string;
  tool: string;
  errorType: string;
  message?: string;
  severity?: 'error' | 'warning' | 'info';
  retryable?: boolean;
  context?: Record<string, unknown>;
}

/**
 * Log a structured pipeline error to the database and publish a WS event.
 * Failures inside this helper are swallowed so callers never blow up on logging.
 */
export async function logPipelineError(input: LogPipelineErrorInput): Promise<void> {
  const catalog = ERROR_MESSAGES[input.errorType];
  const message = input.message ?? catalog?.message ?? input.errorType;
  const retryable = input.retryable ?? catalog?.retryable ?? false;
  const severity = input.severity ?? 'error';

  try {
    if (input.tenantId) {
      const row = await withTenant(input.tenantId, async (tx) => {
        const [inserted] = await tx
          .insert(pipelineErrors)
          .values({
            tenantId: input.tenantId,
            masterAgentId: input.masterAgentId ?? null,
            step: input.step,
            tool: input.tool,
            severity,
            errorType: input.errorType,
            message,
            context: input.context ?? null,
            retryable,
          })
          .returning();
        return inserted;
      });

      try {
        await pubRedis.publish(
          `agent-events:${input.tenantId}`,
          JSON.stringify({
            event: 'pipeline:error',
            data: {
              id: row?.id,
              masterAgentId: input.masterAgentId ?? null,
              step: input.step,
              tool: input.tool,
              severity,
              errorType: input.errorType,
              message,
              retryable,
              context: input.context ?? null,
            },
            timestamp: new Date().toISOString(),
          }),
        );
      } catch {
        /* publish errors are non-critical */
      }
    }
  } catch (err) {
    logger.warn({ err, input }, 'logPipelineError failed to persist — continuing');
  }

  logger.warn({
    tenantId: input.tenantId,
    masterAgentId: input.masterAgentId,
    step: input.step,
    tool: input.tool,
    errorType: input.errorType,
    severity,
    retryable,
    context: input.context,
  }, `Pipeline error: ${message}`);
}
