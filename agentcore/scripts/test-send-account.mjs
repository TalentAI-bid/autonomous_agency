#!/usr/bin/env node
/**
 * Diagnostic probe for the per-account SMTP + IMAP-append flow.
 *
 * Reads creds from the dashboard-managed DB tables — same source the production
 * app uses — so it tests the EXACT path the running service takes.
 *
 *   email_accounts          — SMTP host/port/user/encrypted-pass + fromEmail
 *   email_listener_configs  — IMAP/POP host/port/username/encrypted-pass per account
 *
 * Required env vars:
 *   DATABASE_URL              (Postgres URL)
 *   EMAIL_ENCRYPTION_KEY      (or JWT_SECRET as fallback — same as the app)
 *
 * Modes:
 *   1. List active email accounts and their linked listener configs:
 *        node --env-file=.env scripts/test-send-account.mjs
 *
 *   2. Send a probe message via the chosen account, then attempt an IMAP append
 *      to its Sent folder, then SEARCH the Sent folder by Message-ID to verify
 *      the append actually stuck:
 *        node --env-file=.env scripts/test-send-account.mjs <emailAccountId> <toAddress>
 *
 * What the probe answers:
 *   - Does the SMTP server actually accept the message? (full transcript via debug:true)
 *   - Does transporter.verify() fail (auth/TLS/port wrong) before we even try sendMail?
 *   - What mailboxes exist on this IMAP account, and which one is flagged \Sent?
 *   - Does APPEND succeed and is the appended message findable by Message-ID afterwards?
 *
 * The user must then manually check the recipient inbox to confirm leg 3
 * (delivery), since we can't see into Gmail/etc. from here.
 */

import { createDecipheriv, scryptSync } from 'node:crypto';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import pg from 'pg';

const { DATABASE_URL, EMAIL_ENCRYPTION_KEY, JWT_SECRET } = process.env;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL env var.');
  console.error('Hint: node --env-file=.env scripts/test-send-account.mjs ...');
  process.exit(1);
}

// Mirror agentcore/src/utils/crypto.ts — aes-256-gcm with scrypt-derived key.
const SALT = 'agentcore-email-encryption';
const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;
function decrypt(ciphertext) {
  const secret = EMAIL_ENCRYPTION_KEY || JWT_SECRET;
  if (!secret) throw new Error('Need EMAIL_ENCRYPTION_KEY or JWT_SECRET in env to decrypt stored passwords');
  const key = scryptSync(secret, SALT, 32);
  const data = Buffer.from(ciphertext, 'base64');
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = data.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

const args = process.argv.slice(2);

// ─── No-arg mode: list accounts ────────────────────────────────────────────
if (args.length === 0) {
  const { rows } = await client.query(`
    SELECT
      a.id, a.tenant_id, a.name, a.from_email, a.smtp_host, a.smtp_port,
      a.smtp_user, a.smtp_pass IS NOT NULL AS has_smtp_pass, a.is_active,
      l.id          AS listener_id,
      l.protocol    AS listener_protocol,
      l.host        AS listener_host,
      l.port        AS listener_port,
      l.username    AS listener_username,
      l.use_tls     AS listener_use_tls,
      l.mailbox     AS listener_mailbox,
      l.is_active   AS listener_active
    FROM email_accounts a
    LEFT JOIN email_listener_configs l ON l.email_account_id = a.id
    ORDER BY a.created_at DESC;
  `);

  if (rows.length === 0) {
    console.log('No email_accounts rows found.');
  } else {
    console.log(`Found ${rows.length} email account(s):\n`);
    for (const r of rows) {
      console.log(`─ ${r.name}  [${r.id}]   active=${r.is_active}`);
      console.log(`  fromEmail: ${r.from_email}`);
      console.log(`  SMTP:      ${r.smtp_host}:${r.smtp_port}  user=${r.smtp_user}  hasPass=${r.has_smtp_pass}`);
      if (r.listener_id) {
        console.log(`  ${r.listener_protocol.toUpperCase()}:      ${r.listener_host}:${r.listener_port}  user=${r.listener_username}  tls=${r.listener_use_tls}  mailbox=${r.listener_mailbox}  active=${r.listener_active}  [${r.listener_id}]`);
      } else {
        console.log(`  IMAP/POP:  (no listener config linked)`);
      }
      console.log('');
    }
    console.log('To probe one of them:');
    console.log('  node --env-file=.env scripts/test-send-account.mjs <emailAccountId> <toAddress>\n');
  }
  await client.end();
  process.exit(0);
}

if (args.length !== 2) {
  console.error('Usage:');
  console.error('  node --env-file=.env scripts/test-send-account.mjs                              # list accounts');
  console.error('  node --env-file=.env scripts/test-send-account.mjs <emailAccountId> <toAddress> # probe send');
  await client.end();
  process.exit(1);
}

const [accountId, toAddress] = args;

// ─── Send mode: load account + listener ────────────────────────────────────
const { rows: acctRows } = await client.query(
  `SELECT * FROM email_accounts WHERE id = $1 LIMIT 1`,
  [accountId],
);
if (acctRows.length === 0) {
  console.error(`No email_accounts row with id=${accountId}`);
  await client.end();
  process.exit(2);
}
const acct = acctRows[0];

const { rows: listenerRows } = await client.query(
  `SELECT * FROM email_listener_configs WHERE email_account_id = $1 AND protocol = 'imap' LIMIT 1`,
  [accountId],
);
const listener = listenerRows[0] ?? null;

console.log('═════════════════════════════════════════════════════════════');
console.log(`Account:  ${acct.name}  <${acct.from_email}>`);
console.log(`SMTP:     ${acct.smtp_host}:${acct.smtp_port}  user=${acct.smtp_user}`);
if (listener) {
  console.log(`IMAP:     ${listener.host}:${listener.port}  user=${listener.username}  tls=${listener.use_tls}`);
} else {
  console.log(`IMAP:     (no listener config — Sent-folder append will be SKIPPED)`);
}
console.log(`To:       ${toAddress}`);
console.log('═════════════════════════════════════════════════════════════\n');

let smtpSummary = 'NOT RUN';
let imapSummary = 'NOT RUN';
let verifySummary = 'NOT RUN';
let sentMessageId = null;
let appendedMailbox = null;
let rawMessage = null;

// ─── SMTP leg ──────────────────────────────────────────────────────────────
console.log('───────────────── SMTP leg ─────────────────');
try {
  const smtpPass = acct.smtp_pass ? decrypt(acct.smtp_pass) : undefined;
  const smtpPort = Number(acct.smtp_port ?? 587);
  const transporter = nodemailer.createTransport({
    host: acct.smtp_host,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: acct.smtp_user ? { user: acct.smtp_user, pass: smtpPass } : undefined,
    logger: true,
    debug: true,
  });

  console.log('[SMTP] verifying transport (auth + TLS handshake)...');
  await transporter.verify();
  console.log('[SMTP] verify OK\n');

  const subject = `Probe ${new Date().toISOString()}  [${acct.name}]`;
  const text = `This is a diagnostic probe from test-send-account.mjs.\n\n`
    + `If you see this in your inbox, SMTP delivery to ${toAddress} works.\n`
    + `If you see this in the Sent folder of ${acct.from_email}, the IMAP append works.\n`;

  // Build raw MIME once so we can SMTP-send and IMAP-append the SAME bytes.
  const streamTx = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const composed = await streamTx.sendMail({
    from: acct.from_email,
    to: toAddress,
    subject,
    text,
    html: `<p>${text.replace(/\n/g, '<br>')}</p>`,
  });
  rawMessage = composed.message;

  console.log('\n[SMTP] sending...');
  const info = await transporter.sendMail({
    envelope: { from: acct.from_email, to: toAddress },
    raw: rawMessage,
  });
  sentMessageId = info.messageId;

  console.log('\n[SMTP] result:');
  console.log('  messageId :', info.messageId);
  console.log('  response  :', info.response);
  console.log('  accepted  :', info.accepted);
  console.log('  rejected  :', info.rejected);
  console.log('  envelope  :', info.envelope);

  if (info.rejected && info.rejected.length > 0) {
    smtpSummary = `REJECTED for ${info.rejected.join(', ')}: ${info.response}`;
  } else {
    smtpSummary = `OK — ${info.response}`;
  }
} catch (err) {
  console.error('\n[SMTP] FAILED:', err);
  smtpSummary = `FAIL — ${err.message ?? err}`;
}

// ─── IMAP append + verify leg ──────────────────────────────────────────────
console.log('\n───────────────── IMAP leg ─────────────────');
if (!listener) {
  imapSummary = 'SKIPPED — no email_listener_configs row linked to this account';
  verifySummary = 'SKIPPED';
  console.log('[IMAP] no listener config — skipping append');
} else if (!rawMessage) {
  imapSummary = 'SKIPPED — SMTP did not produce a raw message';
  verifySummary = 'SKIPPED';
  console.log('[IMAP] SMTP failed earlier; nothing to append');
} else {
  let imap = null;
  try {
    const imapPass = decrypt(listener.password);
    imap = new ImapFlow({
      host: listener.host,
      port: Number(listener.port),
      secure: !!listener.use_tls,
      auth: { user: listener.username, pass: imapPass },
      logger: false,
    });

    console.log(`[IMAP] connecting to ${listener.host}:${listener.port} (tls=${listener.use_tls})...`);
    await imap.connect();
    console.log('[IMAP] connected\n');

    console.log('[IMAP] listing mailboxes:');
    const mailboxes = await imap.list();
    for (const m of mailboxes) {
      const flags = m.specialUse ? `  [${m.specialUse}]` : '';
      console.log(`  - ${m.path}${flags}`);
    }

    // Pick Sent folder: prefer \Sent specialUse flag, else known names.
    const flaggedSent = mailboxes.find((m) => m.specialUse === '\\Sent');
    const candidates = [
      flaggedSent?.path,
      'Sent',
      'INBOX.Sent',
      'Sent Items',
      'INBOX.Sent Items',
    ].filter(Boolean);

    console.log(`\n[IMAP] candidate Sent mailboxes (in order): ${candidates.join(', ')}`);

    let appendUid = null;
    for (const box of candidates) {
      try {
        const res = await imap.append(box, rawMessage, ['\\Seen']);
        if (res) {
          appendedMailbox = box;
          appendUid = res.uid ?? null;
          break;
        }
      } catch (err) {
        console.log(`[IMAP] append to "${box}" failed: ${err.message ?? err}`);
      }
    }

    if (!appendedMailbox) {
      imapSummary = 'FAIL — APPEND rejected by every candidate mailbox';
      verifySummary = 'SKIPPED';
    } else {
      console.log(`\n[IMAP] APPEND OK to "${appendedMailbox}" uid=${appendUid}`);
      imapSummary = `OK — appended to "${appendedMailbox}" uid=${appendUid}`;

      // Verify by reopening and SEARCHing for the Message-ID we just sent.
      const lock = await imap.getMailboxLock(appendedMailbox);
      try {
        const idClean = String(sentMessageId ?? '').replace(/^<|>$/g, '');
        const uids = await imap.search({ header: { 'message-id': idClean } });
        if (uids && uids.length > 0) {
          console.log(`[IMAP] verify: Sent folder contains the message — UIDs=${JSON.stringify(uids)}`);
          verifySummary = `OK — Message-ID found in "${appendedMailbox}" (UIDs ${uids.join(',')})`;
        } else {
          console.log('[IMAP] verify: Message-ID NOT found after append — server may have silently dropped it');
          verifySummary = 'FAIL — APPEND returned OK but search by Message-ID found nothing';
        }
      } finally {
        lock.release();
      }
    }
  } catch (err) {
    console.error('[IMAP] FAILED:', err);
    imapSummary = `FAIL — ${err.message ?? err}`;
    verifySummary = 'SKIPPED';
  } finally {
    if (imap) {
      try { await imap.logout(); } catch { /* ignore */ }
    }
  }
}

await client.end();

// ─── Final summary ─────────────────────────────────────────────────────────
console.log('\n═══════════════════ SUMMARY ════════════════════════════════');
console.log(`SMTP submit : ${smtpSummary}`);
console.log(`IMAP append : ${imapSummary}`);
console.log(`IMAP verify : ${verifySummary}`);
console.log('─────────────────────────────────────────────────────────────');
console.log(`Now check the inbox at ${toAddress} (and its spam folder!) to`);
console.log(`confirm whether the recipient actually received the message.`);
console.log(`Then log into the webmail of ${acct.from_email} and check the`);
console.log(`Sent folder — it should contain the same message if APPEND worked.`);
console.log('═════════════════════════════════════════════════════════════');
