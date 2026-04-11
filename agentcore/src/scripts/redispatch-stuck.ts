import { Queue } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { db } from '../config/database.js';
import { companies } from '../db/schema/index.js';
import { lte } from 'drizzle-orm';

async function main() {
  const connection = createRedisConnection();

  const stuck = await db.select({
    id: companies.id,
    name: companies.name,
    tenantId: companies.tenantId,
    masterAgentId: companies.masterAgentId,
  })
  .from(companies)
  .where(lte(companies.dataCompleteness, 15));

  console.log(`Found ${stuck.length} stuck companies`);

  const queueCache = new Map<string, Queue>();
  function getEnrichmentQueue(tenantId: string): Queue {
    const name = `queue.enrichment.${tenantId}`;
    let q = queueCache.get(name);
    if (!q) {
      q = new Queue(name, { connection: connection as any });
      queueCache.set(name, q);
    }
    return q;
  }

  let dispatched = 0;
  for (const company of stuck) {
    if (!company.masterAgentId) {
      console.log(`  SKIP ${company.name} — no masterAgentId`);
      continue;
    }
    const queue = getEnrichmentQueue(company.tenantId);
    await queue.add('enrichment-job', {
      companyId: company.id,
      masterAgentId: company.masterAgentId,
      tenantId: company.tenantId,
    });
    dispatched++;
    console.log(`  [${dispatched}] ${company.name} (${company.id})`);
  }

  console.log(`\nDispatched ${dispatched} enrichment jobs`);
  for (const q of queueCache.values()) await q.close();
  await connection.quit();
  process.exit(0);
}

main().catch(console.error);
