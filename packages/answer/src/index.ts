import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import getEnv from '@unipods/shared/src/config';
import { hybridSearch, findDuplicateQuestion, getLastSyncTimestamp, getRecentChunks, getRecentThreadHistory } from '@unipods/shared/src/retrieval';
import { generateAnswer } from '@unipods/shared/src/llm';
import { query } from '@unipods/shared/src/db';
import {
  parseWebhookPayload,
  sendWhatsAppReply,
  sendTypingIndicator,
  formatAnswerForWhatsApp,
  WhatsAppMessage,
} from './whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });
const env = getEnv();

const app = express();

// ── Middleware ─────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('short'));

// ── Health check ──────────────────────────────────────────────
app.get('/health', async (_req: Request, res: Response) => {
  const lastSync = await getLastSyncTimestamp();
  res.json({
    status: 'ok',
    service: 'answer',
    last_sync: lastSync?.toISOString() ?? null,
    timestamp: new Date().toISOString(),
  });
});

// ── WhatsApp webhook verification ─────────────────────────────
app.get('/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logger.info({ mode, token }, '🔐 Webhook verification request');

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    logger.warn('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// ── WhatsApp webhook message handler ──────────────────────────
app.post('/webhook', async (req: Request, res: Response) => {
  // Always respond 200 immediately — Meta will retry if we take too long
  res.sendStatus(200);

  const { messages } = parseWebhookPayload(req.body);
  if (messages.length === 0) return;

  for (const msg of messages) {
    if (msg.type !== 'text' || !msg.text?.body) continue;

    // ── Group message rules ────────────────────────────────────
    if (msg.is_group) {
      // In a group: ONLY respond when @mentioned
      // (prevents the bot from answering every single message)
      if (!msg.is_mention) {
        logger.debug({ msgId: msg.id }, '📥 Group message received but bot not @mentioned — skipping');
        continue;
      }
      logger.info({ group: msg.group_id, sender: msg.name }, '📣 Bot @mentioned in group');
    } else {
      logger.info({ from: msg.from, sender: msg.name }, '📩 DM received');
    }

    // Use clean_text (with @mention stripped) as the question
    const question = (msg.clean_text ?? msg.text.body).trim();
    if (!question) continue;

    // Reply destination:
    // - Group message → reply to group JID (appears in the group chat)
    // - DM          → reply to sender's phone number
    const replyTo = msg.is_group ? msg.group_id! : msg.from;

    handleQuestion(question, replyTo, msg.from, msg.name, msg.id, msg).catch((err) => {
      logger.error({ err, replyTo, question }, 'Failed to handle question');
    });
  }
});

// ── Core Q&A handler ──────────────────────────────────────────
async function handleQuestion(
  question: string,
  replyTo: string,          // group JID or personal phone — WHERE to send the reply
  senderPhone: string,      // who asked (for logging)
  senderName: string | undefined,
  messageId: string,
  msg: WhatsAppMessage
): Promise<void> {
  // 1. Acknowledge (mark as read)
  await sendTypingIndicator(replyTo, messageId);

  // 2. Freshness check
  const lastSync = await getLastSyncTimestamp();
  const freshnessMins = lastSync
    ? (Date.now() - lastSync.getTime()) / 60000
    : null;

  // 3. Duplicate detection
  let isDuplicate = false;
  let duplicateContext: string | undefined;

  if (env.ENABLE_DUPLICATE_DETECTION === 'true') {
    const dup = await findDuplicateQuestion(question);
    if (dup) {
      isDuplicate = true;
      duplicateContext = dup.context;
      logger.info({ dupDate: dup.date }, '🔁 Duplicate question detected');
    }
  }

  // 4. Hybrid retrieval
  const chunks = await hybridSearch(question, {
    groupId: env.GROUP_ID || undefined,
    topK: 8,
    recencyBoost: true,
  });

  logger.info(
    { chunksFound: chunks.length, topSim: chunks[0]?.similarity?.toFixed(3) },
    '🔍 Retrieval complete'
  );

  // 5. Generate answer with Claude / GPT
  const answerResult = await generateAnswer(question, chunks, {
    isDuplicateQuestion: isDuplicate,
    duplicateContext,
    freshnessMins: freshnessMins ?? undefined,
    userName: senderName,
  });

  // 6. Format for WhatsApp (group-aware — addresses sender by name in groups)
  const formattedAnswer = formatAnswerForWhatsApp(
    answerResult.answer,
    answerResult.confidence,
    isDuplicate,
    { isGroup: msg.is_group, senderName: senderName }
  );

  // 7. Send reply — to the GROUP if group message, to the person if DM
  await sendWhatsAppReply(replyTo, formattedAnswer, messageId);

  // 8. Log to DB (for dashboard)
  await query(
    `INSERT INTO answers (question, answer, user_phone, user_name, confidence, is_duplicate, sources, chunk_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      question,
      answerResult.answer,
      senderPhone,
      senderName ?? null,
      answerResult.confidence,
      isDuplicate,
      JSON.stringify(answerResult.sources),
      chunks.map((c) => c.id),
    ]
  );

  logger.info(
    {
      replyTo,
      isGroup: msg.is_group,
      confidence: answerResult.confidence,
      isDuplicate,
    },
    '✅ Answer sent'
  );
}

// ── Manual test endpoint (no WhatsApp needed) ─────────────────
app.post('/ask', async (req: Request, res: Response) => {
  try {
    const { question, user_phone = 'test', user_name, group_id } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }

    const lastSync = await getLastSyncTimestamp();
    const freshnessMins = lastSync ? (Date.now() - lastSync.getTime()) / 60000 : null;

    const dup = env.ENABLE_DUPLICATE_DETECTION === 'true'
      ? await findDuplicateQuestion(question)
      : null;

    const isSummaryQuery = /^\s*(summarize|summary|summaries|digest|overview|recap|recent chat|recent messages|what happened|what's new)/i.test(question);

    const targetGroup = group_id || env.GROUP_ID || undefined;

    const chunks = isSummaryQuery
      ? await getRecentChunks(targetGroup, 30)
      : await hybridSearch(question, {
          groupId: targetGroup,
          topK: 8,
          recencyBoost: true,
        });

    const conversationHistory = targetGroup
      ? await getRecentThreadHistory(targetGroup, 6)
      : undefined;

    const answerResult = await generateAnswer(question, chunks, {
      isDuplicateQuestion: !!dup,
      duplicateContext: dup?.context,
      freshnessMins: freshnessMins ?? undefined,
      userName: user_name,
      conversationHistory,
    });

    return res.json({
      ...answerResult,
      freshness_mins: freshnessMins,
      chunks_found: chunks.length,
    });
  } catch (err: unknown) {
    logger.error({ err }, 'Error in /ask route');
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('429') || msg.includes('Quota exceeded')) {
      return res.status(429).json({
        answer: '⏳ Rate limit reached. Gemini API free tier limit exceeded (5 req/min) — please wait ~30 seconds before asking again.',
        confidence: 'insufficient',
        is_duplicate_question: false,
      });
    }
    return res.status(500).json({
      answer: '⚠️ An error occurred while generating an answer. Please try again.',
      confidence: 'insufficient',
      is_duplicate_question: false,
    });
  }
});

// ── Stats (for dashboard) ─────────────────────────────────────
app.get('/stats', async (_req: Request, res: Response) => {
  const { queryOne } = await import('@unipods/shared/src/db');
  const stats = await queryOne<Record<string, unknown>>('SELECT get_bot_stats()');
  res.json(stats?.get_bot_stats ?? {});
});

// ── Recent answers (for dashboard) ───────────────────────────
app.get('/answers', async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const rows = await query<Record<string, unknown>>(
    `SELECT id, question, answer, user_name, confidence, is_duplicate, created_at
     FROM answers ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  res.json(rows);
});

// ── Error handler ─────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled Express error');
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, '🚨 Uncaught Exception in answer service process');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '🚨 Unhandled Rejection in answer service process');
});

app.listen(env.ANSWER_SERVICE_PORT, () => {
  logger.info(`🤖 Answer service running on port ${env.ANSWER_SERVICE_PORT}`);
  logger.info(`📬 Webhook: POST /webhook`);
  logger.info(`   Group mode: @mention the bot in the group to trigger answers`);
  logger.info(`   DM mode: message the bot number directly`);
});

export { app };
