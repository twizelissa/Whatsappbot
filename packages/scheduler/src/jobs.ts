import cron from 'node-cron';
import getEnv from '@unipods/shared/src/config';
import { query } from '@unipods/shared/src/db';
import { hybridSearch } from '@unipods/shared/src/retrieval';
import { generateDigest, generateCallRecap } from '@unipods/shared/src/llm';
import { RetrievedChunk } from '@unipods/shared/src/types';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

const WHATSAPP_API_BASE = 'https://graph.facebook.com/v20.0';

// ── WhatsApp sender ────────────────────────────────────────────
async function sendToGroup(text: string): Promise<void> {
  const env = getEnv();
  if (!env.GROUP_ID) {
    logger.warn('No GROUP_ID set — skipping group message send');
    return;
  }

  const res = await fetch(
    `${WHATSAPP_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: env.GROUP_ID,
        type: 'text',
        text: { body: text.slice(0, 4096) },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json();
    logger.error({ err }, 'Failed to send to group');
    throw new Error(`WhatsApp send error: ${JSON.stringify(err)}`);
  }

  logger.info('📤 Message sent to group');
}

// ── Daily Digest ───────────────────────────────────────────────
export async function runDailyDigest(): Promise<void> {
  logger.info('📋 Running daily digest...');

  const env = getEnv();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Fetch recent chunks for the period
  const chunks = await query<RetrievedChunk>(
    `SELECT id, source_id, source_type, text, metadata, created_at, 1.0 as similarity
     FROM chunks
     WHERE created_at >= $1 AND created_at <= $2
       ${env.GROUP_ID ? `AND metadata->>'group_id' = '${env.GROUP_ID}'` : ''}
     ORDER BY created_at ASC
     LIMIT 200`,
    [yesterday, now]
  );

  if (chunks.length === 0) {
    logger.info('No new content for digest');
    return;
  }

  const digest = await generateDigest(chunks, { from: yesterday, to: now });
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const message = `📰 *UniPods Daily Digest — ${dateStr}*\n\n${digest}`;

  await sendToGroup(message);

  // Log digest
  await query(
    `INSERT INTO digests (period_start, period_end, digest_type, content, sent_to)
     VALUES ($1, $2, 'daily', $3, $4)`,
    [yesterday, now, message, [env.GROUP_ID]]
  );

  logger.info('✅ Daily digest sent');
}

// ── Auto-Recap after calls ─────────────────────────────────────
export async function runCallRecap(callId: string): Promise<void> {
  logger.info({ callId }, '📞 Generating call recap...');

  const chunks = await query<RetrievedChunk>(
    `SELECT id, source_id, source_type, text, metadata, created_at, 1.0 as similarity
     FROM chunks
     WHERE source_type = 'transcript' AND metadata->>'call_id' = $1
     ORDER BY (metadata->>'start')::float ASC`,
    [callId]
  );

  if (chunks.length === 0) {
    logger.warn({ callId }, 'No transcript chunks found for recap');
    return;
  }

  const recap = await generateCallRecap(chunks, callId);
  const message = `📞 *Call Recap*\n\n${recap}`;

  await sendToGroup(message);

  await query(
    `INSERT INTO digests (period_start, period_end, digest_type, call_id, content, sent_to)
     VALUES (NOW() - INTERVAL '2 hours', NOW(), 'call_recap', $1, $2, $3)`,
    [callId, message, [getEnv().GROUP_ID]]
  );

  logger.info({ callId }, '✅ Call recap sent');
}

// ── Poll for new unrecapped calls ──────────────────────────────
export async function checkForNewCallRecaps(): Promise<void> {
  // Find transcript call_ids that don't have a recap yet
  const newCalls = await query<{ call_id: string }>(
    `SELECT DISTINCT t.call_id
     FROM transcripts t
     LEFT JOIN digests d ON d.call_id = t.call_id AND d.digest_type = 'call_recap'
     WHERE d.id IS NULL
       AND t.created_at >= NOW() - INTERVAL '24 hours'`
  );

  for (const { call_id } of newCalls) {
    try {
      await runCallRecap(call_id);
    } catch (err) {
      logger.error({ err, call_id }, 'Failed to generate call recap');
    }
  }
}

// ── Weekly Digest ──────────────────────────────────────────────
export async function runWeeklyDigest(): Promise<void> {
  logger.info('📅 Running weekly digest...');

  const env = getEnv();
  const now = new Date();
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const chunks = await query<RetrievedChunk>(
    `SELECT id, source_id, source_type, text, metadata, created_at, 1.0 as similarity
     FROM chunks
     WHERE created_at >= $1 AND created_at <= $2
     ORDER BY created_at ASC
     LIMIT 500`,
    [lastWeek, now]
  );

  if (chunks.length === 0) return;

  const digest = await generateDigest(chunks, { from: lastWeek, to: now });
  const fromStr = lastWeek.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const toStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const message = `📅 *UniPods Weekly Recap — ${fromStr} to ${toStr}*\n\n${digest}`;

  await sendToGroup(message);

  await query(
    `INSERT INTO digests (period_start, period_end, digest_type, content, sent_to)
     VALUES ($1, $2, 'weekly', $3, $4)`,
    [lastWeek, now, message, [env.GROUP_ID]]
  );

  logger.info('✅ Weekly digest sent');
}

// ── Schedule jobs ──────────────────────────────────────────────
export function startScheduler(): void {
  const env = getEnv();

  // Daily digest (configurable, default: 8am)
  cron.schedule(env.DIGEST_CRON, async () => {
    await runDailyDigest().catch((err) => logger.error({ err }, 'Daily digest failed'));
  });

  // Weekly digest: every Monday at 9am
  cron.schedule('0 9 * * 1', async () => {
    await runWeeklyDigest().catch((err) => logger.error({ err }, 'Weekly digest failed'));
  });

  // Check for new call recaps: every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    if (env.ENABLE_PROACTIVE_RECAP === 'true') {
      await checkForNewCallRecaps().catch((err) =>
        logger.error({ err }, 'Call recap check failed')
      );
    }
  });

  logger.info(`⏰ Scheduler started`);
  logger.info(`   Daily digest: ${env.DIGEST_CRON}`);
  logger.info(`   Weekly digest: Mondays 9am`);
  logger.info(`   Call recap check: every 5 minutes`);
}
