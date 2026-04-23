import type { FastifyInstance } from 'fastify';
import { readFile } from 'fs/promises';
import path from 'path';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

// Public, un-authenticated routes that serve the extension package and the
// Chrome auto-update manifest. Mounted at `/extension/*` (no /api prefix) so
// the URLs match what ships inside manifest.json as `update_url`.
export default async function extensionDistributionRoutes(fastify: FastifyInstance) {
  // Chrome polls this every ~5h and installs the referenced CRX if the
  // version is newer than the one installed.
  fastify.get('/updates.xml', async (_request, reply) => {
    try {
      const latest = await readLatest();
      const crxUrl = `${env.PUBLIC_API_URL}/extension/talentai-v${latest.version}.crx`;
      const xml =
        `<?xml version='1.0' encoding='UTF-8'?>\n` +
        `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
        `  <app appid='${latest.extensionId}'>\n` +
        `    <updatecheck codebase='${crxUrl}' version='${latest.version}' />\n` +
        `  </app>\n` +
        `</gupdate>\n`;
      reply.type('application/xml').send(xml);
    } catch (err) {
      logger.error({ err }, 'Failed to serve extension updates.xml');
      reply.code(500).send('error');
    }
  });

  // Signed CRX for auto-update.
  fastify.get<{ Params: { version: string } }>(
    '/talentai-v:version.crx',
    async (request, reply) => {
      const { version } = request.params;
      if (!isValidVersion(version)) {
        return reply.code(400).send({ error: 'Invalid version' });
      }
      try {
        const buf = await readFile(
          path.join(env.EXTENSION_RELEASES_DIR, `talentai-v${version}.crx`),
        );
        reply.type('application/x-chrome-extension').send(buf);
      } catch {
        reply.code(404).send({ error: 'Version not found' });
      }
    },
  );

  // Unsigned ZIP for manual install (first-time users on Chrome dev mode,
  // Edge, Firefox).
  fastify.get<{ Params: { version: string } }>(
    '/talentai-v:version.zip',
    async (request, reply) => {
      const { version } = request.params;
      if (!isValidVersion(version)) {
        return reply.code(400).send({ error: 'Invalid version' });
      }
      try {
        const buf = await readFile(
          path.join(env.EXTENSION_RELEASES_DIR, `talentai-v${version}.zip`),
        );
        reply
          .type('application/zip')
          .header('Content-Disposition', `attachment; filename="talentai-v${version}.zip"`)
          .send(buf);
      } catch {
        reply.code(404).send({ error: 'Version not found' });
      }
    },
  );
}

function isValidVersion(v: string): boolean {
  return /^[\d.]+$/.test(v);
}

type LatestFile = {
  version: string;
  extensionId: string;
  releasedAt?: string;
  releaseNotes?: string;
  sizeBytes?: number;
};

async function readLatest(): Promise<LatestFile> {
  const raw = await readFile(path.join(env.EXTENSION_RELEASES_DIR, 'latest.json'), 'utf-8');
  return JSON.parse(raw) as LatestFile;
}

export { readLatest };
