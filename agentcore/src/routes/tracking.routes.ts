import type { FastifyInstance } from 'fastify';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { emailsSent } from '../db/schema/index.js';
import logger from '../utils/logger.js';

// 1x1 transparent GIF (43 bytes)
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export default async function trackingRoutes(fastify: FastifyInstance) {
  // GET /track/open/:trackingId — No auth required (email clients hit this)
  fastify.get('/open/:trackingId', async (request, reply) => {
    const { trackingId } = request.params as { trackingId: string };

    // Fire-and-forget the DB update — don't block the pixel response
    setImmediate(async () => {
      try {
        // Only set openedAt if currently null (first-open tracking)
        await db.update(emailsSent)
          .set({ openedAt: new Date() })
          .where(
            and(
              eq(emailsSent.trackingId, trackingId),
              isNull(emailsSent.openedAt),
            ),
          );
      } catch (err) {
        logger.warn({ err, trackingId }, 'Failed to record email open');
      }
    });

    return reply
      .header('Content-Type', 'image/gif')
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .send(TRANSPARENT_GIF);
  });
}
