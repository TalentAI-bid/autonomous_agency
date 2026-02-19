import dns from 'dns';
import net from 'net';
import { Redis } from 'ioredis';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';

export interface EmailResult {
  email: string;
  verified: boolean;
  confidence: 'high' | 'medium' | 'low';
}

const redis: Redis = createRedisConnection();
const CACHE_TTL_SEC = 30 * 24 * 3600; // 30 days

function buildPatterns(firstName: string, lastName: string, domain: string): Array<{ email: string; confidence: 'high' | 'medium' | 'low' }> {
  const f = firstName[0]?.toLowerCase() ?? '';
  const l = lastName[0]?.toLowerCase() ?? '';
  const first = firstName.toLowerCase();
  const last = lastName.toLowerCase();
  return [
    { email: `${first}.${last}@${domain}`, confidence: 'high' },
    { email: `${first}${last}@${domain}`, confidence: 'high' },
    { email: `${f}${last}@${domain}`, confidence: 'medium' },
    { email: `${first}@${domain}`, confidence: 'medium' },
    { email: `${first}${l}@${domain}`, confidence: 'low' },
    { email: `${f}.${last}@${domain}`, confidence: 'low' },
  ];
}

async function getMXServer(domain: string): Promise<string | null> {
  try {
    const records = await dns.promises.resolveMx(domain);
    if (!records.length) return null;
    records.sort((a, b) => a.priority - b.priority);
    return records[0]!.exchange;
  } catch {
    return null;
  }
}

async function smtpVerify(email: string, mxServer: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(25, mxServer);
    let data = '';
    let stage = 0;
    const TIMEOUT = 8000;

    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, TIMEOUT);

    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (stage === 0 && data.includes('220')) {
        socket.write(`EHLO agentcore.app\r\n`);
        stage = 1;
      } else if (stage === 1 && (data.includes('250') || data.includes('200'))) {
        socket.write(`MAIL FROM:<verify@agentcore.app>\r\n`);
        stage = 2;
      } else if (stage === 2 && (data.includes('250') || data.includes('200'))) {
        socket.write(`RCPT TO:<${email}>\r\n`);
        stage = 3;
      } else if (stage === 3) {
        clearTimeout(timer);
        socket.write('QUIT\r\n');
        socket.destroy();
        resolve(data.includes('250'));
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });

    socket.on('close', () => {
      clearTimeout(timer);
    });
  });
}

export async function findEmail(
  tenantId: string,
  firstName: string,
  lastName: string,
  domain: string,
): Promise<EmailResult | null> {
  const cacheKey = `tenant:${tenantId}:email:${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as EmailResult;

  const patterns = buildPatterns(firstName, lastName, domain);
  const mxServer = await getMXServer(domain);

  if (mxServer) {
    for (const pattern of patterns) {
      try {
        const verified = await smtpVerify(pattern.email, mxServer);
        if (verified) {
          const result: EmailResult = { email: pattern.email, verified: true, confidence: pattern.confidence };
          await redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(result));
          return result;
        }
      } catch (err) {
        logger.warn({ err, email: pattern.email }, 'SMTP verify error');
      }
    }
  }

  // Return highest-confidence pattern unverified
  if (patterns.length > 0) {
    const result: EmailResult = { email: patterns[0]!.email, verified: false, confidence: patterns[0]!.confidence };
    await redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(result));
    return result;
  }

  return null;
}
