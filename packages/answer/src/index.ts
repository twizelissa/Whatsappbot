import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import getEnv from '@unipods/shared/src/config';
import { hybridSearch, findDuplicateQuestion, getLastSyncTimestamp } from '@unipods/shared/src/retrieval';
import { generateAnswer } from '@unipods/shared/src/llm';
import { query } from '@unipods/shared/src/db';
import {
  parseWebhookPayload,
  sendWhatsAppReply,
  sendTypingIndicator,
  formatAnswerForWhatsApp,
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
  // Always respond 200 immediately to Meta
  res.sendStatus(200);

  const { messages } = parseWebhookPayload(req.body);
  if (messages.length === 0) return;

  for (const msg of messages) {
    if (msg.type !== 'text' || !msg.text?.body) continue;

    const question = msg.text.body.trim();
    const userPhone = msg.from;
    const userName = msg.senderName;

    logger.info({ userPhone, userName, question }, '❓ Incoming question');

    // Non-blocking: process and reply asynchronously
    handleQuestion(question, userPhone, userName, msg.id).catch((err) => {
      logger.error({ err, userPhone, question }, 'Failed to handle question');
    });
  }
});

// ── Core Q&A handler ──────────────────────────────────────────
async function handleQuestion(
  question: string,
  userPhone: string,
  userName: string | undefined,
  messageId: string
): Promise<void> {
  // 1. Acknowledge receipt
  await sendTypingIndicator(userPhone, messageId);

  // 2. Check freshness
  const lastSync = await getLastSyncTimestamp();
  const freshnessMins = lastSync
    ? (Date.now() - lastSync.getTime()) / 60000
    : null;

  // 3. Check for duplicate question
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

  logger.info({ chunksFound: chunks.length, topSim: chunks[0]?.similarity }, '🔍 Retrieval complete');

  // 5. Generate answer
  const answerResult = await generateAnswer(question, chunks, {
    isDuplicateQuestion: isDuplicate,
    duplicateContext,
    freshnessMins: freshnessMins ?? undefined,
    userName,
  });

  // 6. Format and send
  const formattedAnswer = formatAnswerForWhatsApp(
    answerResult.answer,
    answerResult.confidence,
    isDuplicate
  );

  await sendWhatsAppReply(userPhone, formattedAnswer, messageId);

  // 7. Log the answer
  await query(
    `INSERT INTO answers (question, answer, user_phone, user_name, confidence, is_duplicate, sources, chunk_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      question,
      answerResult.answer,
      userPhone,
      userName ?? null,
      answerResult.confidence,
      isDuplicate,
      JSON.stringify(answerResult.sources),
      chunks.map((c) => c.id),
    ]
  );

  logger.info(
    { userPhone, confidence: answerResult.confidence, isDuplicate },
    '✅ Answer sent'
  );
}

// ── Manual Q&A endpoint (for testing without WhatsApp) ────────
app.post('/ask', async (req: Request, res: Response) => {
  const { question, user_phone = 'test', user_name } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'question is required' });
  }

  const lastSync = await getLastSyncTimestamp();
  const freshnessMins = lastSync ? (Date.now() - lastSync.getTime()) / 60000 : null;

  const dup = env.ENABLE_DUPLICATE_DETECTION === 'true'
    ? await findDuplicateQuestion(question)
    : null;

  const chunks = await hybridSearch(question, {
    groupId: env.GROUP_ID || undefined,
    topK: 8,
    recencyBoost: true,
  });

  const answerResult = await generateAnswer(question, chunks, {
    isDuplicateQuestion: !!dup,
    duplicateContext: dup?.context,
    freshnessMins: freshnessMins ?? undefined,
    userName: user_name,
  });

  res.json({
    ...answerResult,
    freshness_mins: freshnessMins,
    chunks_found: chunks.length,
  });
});

// ── Stats endpoint (for dashboard) ───────────────────────────
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
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(env.ANSWER_SERVICE_PORT, () => {
  logger.info(`🤖 Answer service running on port ${env.ANSWER_SERVICE_PORT}`);
  logger.info(`📬 Webhook URL: http://your-host:${env.ANSWER_SERVICE_PORT}/webhook`);
});

export { app };
