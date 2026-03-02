/**
 * Mailbox Agent Integration Test
 *
 * Tests the MailboxAgent: migration, threading, CRM integration, bulk actions,
 * digest, and API routes.
 *
 * Prerequisites: postgres + redis running, .env configured
 * Usage:  cd agentcore && npx tsx scripts/test-mailbox-agent.ts
 * Output: agentcore/scripts/mailbox-test-results.json
 */

import { readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

// ── Load .env (must run before any app module import) ────────────────────────

function loadEnv(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const envPath = join(scriptDir, '..', '.env');

  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf-8');
  } catch {
    return;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv();

// ── Constants ────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, 'mailbox-test-results.json');
const MIGRATION_PATH = join(
  __dirname,
  '..',
  'src',
  'db',
  'migrations',
  '0004_mailbox_agent.sql',
);
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const PORT = process.env.PORT ?? '4000';
const BASE_URL = `http://localhost:${PORT}`;

if (!DATABASE_URL) {
  console.error(
    `[mailbox-test] ERROR: DATABASE_URL is not set.\n` +
      `  Make sure agentcore/.env exists and contains DATABASE_URL, then run:\n` +
      `    cd agentcore && npx tsx scripts/test-mailbox-agent.ts\n`,
  );
  process.exit(1);
}

// ── Types & helpers ──────────────────────────────────────────────────────────

interface TestResult {
  test: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  data?: unknown;
  error?: string;
}

const results: TestResult[] = [];

function log(msg: string) {
  console.log(`[mailbox-test] ${msg}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runTest(
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  log(`Test: ${name}`);
  const start = Date.now();
  try {
    const data = await fn();
    const duration = Date.now() - start;
    results.push({ test: name, status: 'pass', durationMs: duration, data });
    log(`  PASS (${duration}ms)\n`);
  } catch (err: any) {
    const duration = Date.now() - start;
    results.push({
      test: name,
      status: 'fail',
      durationMs: duration,
      error: err.message ?? String(err),
    });
    log(`  FAIL (${duration}ms) — ${err.message ?? err}\n`);
  }
}

async function checkApiAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('Starting Mailbox Agent integration test\n');

  // ── Step 1: Apply migration ────────────────────────────────────────────────
  log('Step 0: Applying migration 0004_mailbox_agent.sql...');
  const migrationPool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf-8');
    await migrationPool.query(migrationSql);
    log('  Migration applied successfully.\n');
  } catch (err: any) {
    // Idempotent DDL — some statements may already exist
    log(`  Migration note: ${err.message}\n`);
  }
  await migrationPool.end();

  // ── Dynamic imports (after env is loaded) ──────────────────────────────────
  const { MailboxAgent } = await import('../src/agents/mailbox.agent.js');
  const { withTenant, closeDatabase } = await import(
    '../src/config/database.js'
  );
  const { seedDefaultStages } = await import(
    '../src/services/crm-activity.service.js'
  );
  const {
    contacts,
    replies,
    emailQueue,
    emailThreads,
    deals,
    crmStages,
  } = await import('../src/db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  const { closeRedisConnections } = await import('../src/queues/setup.js');

  let tenantId = '';
  let token = '';
  let contactId = '';
  let replyId = '';
  let emailQueueId = '';
  let threadId = '';
  let dealId = '';

  try {
    // ── Step 2: Register test tenant ───────────────────────────────────────
    log('Registering test tenant...');
    const ts = Date.now();
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `mailbox-test-${ts}@test.local`,
        password: 'testPassword123!',
        name: 'Mailbox Test',
        tenantName: `Mailbox Test ${ts}`,
        tenantSlug: `mailbox-test-${ts}`,
      }),
    });

    if (!regRes.ok) {
      const text = await regRes.text();
      throw new Error(`Registration failed (${regRes.status}): ${text}`);
    }

    const regData = (await regRes.json()) as {
      data: { token: string; tenant: { id: string } };
    };
    tenantId = regData.data.tenant.id;
    token = regData.data.token;
    log(`  Tenant ID: ${tenantId}`);
    log(`  JWT acquired.\n`);

    // ── Seed CRM stages ───────────────────────────────────────────────────
    log('Seeding CRM stages...');
    await seedDefaultStages(tenantId);
    log('  Stages seeded.\n');

    // ── Step 3: Seed test data ────────────────────────────────────────────
    log('Seeding test data...');

    // Insert contact
    const [contact] = await withTenant(tenantId, async (tx: any) => {
      return tx
        .insert(contacts)
        .values({
          tenantId,
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane@acme.com',
          status: 'discovered',
        })
        .returning();
    });
    contactId = contact!.id;
    log(`  Contact created: ${contactId}`);

    // Insert inbound reply
    const [reply] = await withTenant(tenantId, async (tx: any) => {
      return tx
        .insert(replies)
        .values({
          tenantId,
          contactId,
          fromEmail: 'jane@acme.com',
          subject: 'Partnership Opportunity',
          body: 'We are interested in your product. Can we schedule a call next week to discuss a potential partnership?',
          isInbound: true,
        })
        .returning();
    });
    replyId = reply!.id;
    log(`  Inbound reply created: ${replyId}`);

    // Insert outbound email queue item
    const [eqItem] = await withTenant(tenantId, async (tx: any) => {
      return tx
        .insert(emailQueue)
        .values({
          tenantId,
          contactId,
          fromEmail: 'team@ourcompany.com',
          toEmail: 'jane@acme.com',
          subject: 'Re: Partnership Opportunity',
          body: 'Hi Jane, thanks for your interest! I would love to schedule a call. How does Thursday at 2pm work?',
          status: 'sent',
        })
        .returning();
    });
    emailQueueId = eqItem!.id;
    log(`  Outbound email created: ${emailQueueId}\n`);

    // ── Test 1: Migration verification ────────────────────────────────────
    await runTest('1_migration_verification', async () => {
      const p = new pg.Pool({ connectionString: DATABASE_URL });
      try {
        // Check email_threads table columns
        const { rows: etCols } = await p.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'email_threads' ORDER BY ordinal_position`,
        );
        const colNames = etCols.map((r: any) => r.column_name);
        assert(colNames.includes('id'), 'email_threads missing id column');
        assert(
          colNames.includes('tenant_id'),
          'email_threads missing tenant_id',
        );
        assert(colNames.includes('status'), 'email_threads missing status');
        assert(
          colNames.includes('priority'),
          'email_threads missing priority',
        );

        // Check replies.tenant_id
        const { rows: rCols } = await p.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'replies' AND column_name = 'tenant_id'`,
        );
        assert(rCols.length > 0, 'replies missing tenant_id column');

        // Check replies.thread_id
        const { rows: rtCols } = await p.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'replies' AND column_name = 'thread_id'`,
        );
        assert(rtCols.length > 0, 'replies missing thread_id column');

        // Check email_queue.thread_id
        const { rows: eqCols } = await p.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'email_queue' AND column_name = 'thread_id'`,
        );
        assert(eqCols.length > 0, 'email_queue missing thread_id column');

        return { emailThreadColumns: colNames.length, checks: 'all passed' };
      } finally {
        await p.end();
      }
    });

    // ── Test 2: thread_email inbound ──────────────────────────────────────
    await runTest('2_thread_email_inbound', async () => {
      const agent = new MailboxAgent({
        tenantId,
        masterAgentId: '',
        agentType: 'mailbox',
      });
      try {
        const result = await agent.execute({
          action: 'thread_email',
          emailId: replyId,
          type: 'inbound',
        });
        assert(result.threadId, 'Expected threadId in result');
        assert(result.dealId, 'Expected dealId in result');
        threadId = result.threadId as string;
        dealId = result.dealId as string;
        return { threadId, dealId, hasAnalysis: !!result.analysis };
      } finally {
        await agent.close();
      }
    });

    // ── Test 3: thread_email outbound (reuses same thread) ────────────────
    await runTest('3_thread_email_outbound', async () => {
      const agent = new MailboxAgent({
        tenantId,
        masterAgentId: '',
        agentType: 'mailbox',
      });
      try {
        const result = await agent.execute({
          action: 'thread_email',
          emailId: emailQueueId,
          type: 'outbound',
        });
        assert(
          result.threadId === threadId,
          `Expected same thread ${threadId}, got ${result.threadId}`,
        );

        // Verify messageCount incremented
        const [thread] = await withTenant(tenantId, async (tx: any) => {
          return tx
            .select({ messageCount: emailThreads.messageCount })
            .from(emailThreads)
            .where(eq(emailThreads.id, threadId))
            .limit(1);
        });
        assert(
          thread && thread.messageCount >= 2,
          `Expected messageCount >= 2, got ${thread?.messageCount}`,
        );

        return { threadId: result.threadId, messageCount: thread?.messageCount };
      } finally {
        await agent.close();
      }
    });

    // ── Test 4: Deal auto-stage ───────────────────────────────────────────
    await runTest('4_deal_auto_stage', async () => {
      const [deal] = await withTenant(tenantId, async (tx: any) => {
        return tx
          .select({ stageId: deals.stageId })
          .from(deals)
          .where(eq(deals.id, dealId))
          .limit(1);
      });
      assert(deal, 'Deal not found');

      const [stage] = await withTenant(tenantId, async (tx: any) => {
        return tx
          .select({
            slug: crmStages.slug,
            name: crmStages.name,
            position: crmStages.position,
          })
          .from(crmStages)
          .where(eq(crmStages.id, deal!.stageId))
          .limit(1);
      });
      assert(stage, 'Stage not found');
      // Inbound processed first → 'replied' (position 2)
      // Outbound processed second → 'contacted' (position 1), but only if current < 1
      // Since deal is already at 'replied' (position 2), outbound won't move it backward
      assert(
        stage.position >= 1,
        `Expected stage position >= 1 (contacted or later), got ${stage.position} (${stage.slug})`,
      );

      return { stage: stage.slug, position: stage.position, name: stage.name };
    });

    // ── Test 5: bulk_action archive ───────────────────────────────────────
    await runTest('5_bulk_action_archive', async () => {
      const agent = new MailboxAgent({
        tenantId,
        masterAgentId: '',
        agentType: 'mailbox',
      });
      try {
        const result = await agent.execute({
          action: 'bulk_action',
          bulkAction: 'archive',
          threadIds: [threadId],
        });
        assert(
          result.affected === 1,
          `Expected 1 affected, got ${result.affected}`,
        );

        // Verify thread status is archived
        const [thread] = await withTenant(tenantId, async (tx: any) => {
          return tx
            .select({ status: emailThreads.status })
            .from(emailThreads)
            .where(eq(emailThreads.id, threadId))
            .limit(1);
        });
        assert(
          thread?.status === 'archived',
          `Expected status 'archived', got '${thread?.status}'`,
        );

        return { affected: result.affected, status: thread?.status };
      } finally {
        await agent.close();
      }
    });

    // Restore thread to 'active' so digest/API tests have data
    await withTenant(tenantId, async (tx: any) => {
      await tx
        .update(emailThreads)
        .set({ status: 'active' })
        .where(eq(emailThreads.id, threadId));
    });

    // ── Test 6: digest ────────────────────────────────────────────────────
    await runTest('6_digest', async () => {
      const agent = new MailboxAgent({
        tenantId,
        masterAgentId: '',
        agentType: 'mailbox',
      });
      try {
        const result = await agent.execute({ action: 'digest' });
        assert(typeof result.active === 'number', 'Expected active count');
        assert(
          typeof result.needsAction === 'number',
          'Expected needsAction count',
        );
        assert(typeof result.waiting === 'number', 'Expected waiting count');
        return {
          active: result.active,
          needsAction: result.needsAction,
          waiting: result.waiting,
          highPriority: result.highPriority,
        };
      } finally {
        await agent.close();
      }
    });

    // ── API Tests (require running server) ────────────────────────────────
    const apiAvailable = await checkApiAvailable();

    if (apiAvailable) {
      // Test 7: GET /api/mailbox/threads
      await runTest('7_api_get_threads', async () => {
        const res = await fetch(`${BASE_URL}/api/mailbox/threads`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        const body = (await res.json()) as any;
        assert(body.data?.data, 'Expected data.data in response');
        assert(Array.isArray(body.data.data), 'Expected array response');
        return { status: res.status, count: body.data.data.length };
      });

      // Test 8: GET /api/mailbox/threads/:id
      await runTest('8_api_get_thread_detail', async () => {
        const res = await fetch(
          `${BASE_URL}/api/mailbox/threads/${threadId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        const body = (await res.json()) as any;
        assert(body.data, 'Expected data object');
        assert(Array.isArray(body.data.messages), 'Expected messages array');
        return {
          status: res.status,
          messageCount: body.data.messages?.length,
          subject: body.data.subject,
        };
      });

      // Test 9: GET /api/mailbox/digest
      await runTest('9_api_get_digest', async () => {
        const res = await fetch(`${BASE_URL}/api/mailbox/digest`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        const body = (await res.json()) as any;
        assert(
          body.data && 'totalThreads' in body.data,
          'Expected totalThreads in digest response',
        );
        return { status: res.status, digest: body.data };
      });

      // Test 10: PATCH /api/mailbox/threads/:id
      await runTest('10_api_patch_thread', async () => {
        const res = await fetch(
          `${BASE_URL}/api/mailbox/threads/${threadId}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ priority: 'high' }),
          },
        );
        assert(res.status === 200, `Expected 200, got ${res.status}`);
        const body = (await res.json()) as any;
        assert(
          body.data?.priority === 'high',
          `Expected priority 'high', got '${body.data?.priority}'`,
        );
        return { status: res.status, updated: body.data };
      });
    } else {
      log(
        '  Server not available at ' +
          BASE_URL +
          ', skipping API tests (7–10).\n',
      );
      for (const name of [
        '7_api_get_threads',
        '8_api_get_thread_detail',
        '9_api_get_digest',
        '10_api_patch_thread',
      ]) {
        results.push({
          test: name,
          status: 'skip',
          durationMs: 0,
          data: 'Server not running',
        });
      }
    }

    // ── Test 11: summarize_thread (optional — requires CLAUDE_API_KEY) ────
    if (process.env.CLAUDE_API_KEY) {
      await runTest('11_summarize_thread', async () => {
        const agent = new MailboxAgent({
          tenantId,
          masterAgentId: '',
          agentType: 'mailbox',
        });
        try {
          const result = await agent.execute({
            action: 'summarize_thread',
            threadId,
          });
          assert(!result.error, `Summarization failed: ${result.error}`);
          assert(result.summary, 'Expected summary in result');
          return { threadId, summary: result.summary };
        } finally {
          await agent.close();
        }
      });
    } else {
      log('  CLAUDE_API_KEY not set, skipping test 11 (summarize_thread).\n');
      results.push({
        test: '11_summarize_thread',
        status: 'skip',
        durationMs: 0,
        data: 'CLAUDE_API_KEY not set',
      });
    }
  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────
    log('Cleaning up test data...');
    if (tenantId) {
      try {
        const cleanPool = new pg.Pool({ connectionString: DATABASE_URL });
        // Cascade delete removes all related rows (contacts, replies, email_queue, threads, deals, etc.)
        await cleanPool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
        await cleanPool.end();
        log('  Test tenant deleted.\n');
      } catch (err: any) {
        log(`  Cleanup warning: ${err.message}\n`);
      }
    }

    // Close DB and Redis connections
    try {
      await closeDatabase();
    } catch {
      /* already closed */
    }
    try {
      await closeRedisConnections();
    } catch {
      /* already closed */
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;

  log(`\n${'='.repeat(55)}`);
  log(
    `Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${results.length} total)`,
  );
  for (const r of results) {
    const icon =
      r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
    log(
      `  ${icon}  ${r.test} (${r.durationMs}ms)${r.error ? ` — ${r.error}` : ''}`,
    );
  }
  log(`${'='.repeat(55)}\n`);

  // Write results JSON
  await writeFile(
    RESULTS_PATH,
    JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2),
  );
  log(`Results written to ${RESULTS_PATH}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[mailbox-test] Fatal error:', err);
  process.exit(1);
});
