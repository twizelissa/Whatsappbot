import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import {
  getEnv,
  hybridSearch,
  findDuplicateQuestion,
  getLastSyncTimestamp,
  getRecentChunks,
  getRecentThreadHistory,
  generateAnswer,
  query,
} from '@unipods/shared';
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
      chunks.map((c: any) => c.id),
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

async function getGroupsFromDatabase(): Promise<{ jid: string; subject: string; participant_count?: number; message_count?: number; last_activity?: string }[]> {
  const groupsMap = new Map<string, { jid: string; subject: string; participant_count?: number; message_count?: number; last_activity?: string }>();

  // 1. Check live Ingestion Service API via HTTP
  try {
    const res = await fetch(`http://localhost:${env.INGESTION_PORT}/groups`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json() as { groups: any[] };
      for (const mg of data.groups || []) {
        if (mg.jid) {
          groupsMap.set(mg.jid, {
            jid: mg.jid,
            subject: mg.subject || mg.jid,
            participant_count: mg.participant_count,
          });
        }
      }
    }
  } catch {}

  // 2. Read active_groups.json disk file fallback
  try {
    const fs = await import('fs');
    const path = await import('path');
    const activeFile = path.resolve(__dirname, '../../../packages/.baileys-auth/active_groups.json');
    const altActiveFile = path.resolve(process.cwd(), 'packages/.baileys-auth/active_groups.json');
    const targetFile = fs.existsSync(activeFile) ? activeFile : (fs.existsSync(altActiveFile) ? altActiveFile : null);

    if (targetFile) {
      const data = JSON.parse(fs.readFileSync(targetFile, 'utf-8')) as any[];
      for (const g of data) {
        if (g.jid && g.is_active && !groupsMap.has(g.jid)) {
          groupsMap.set(g.jid, {
            jid: g.jid,
            subject: g.subject || g.jid,
            participant_count: g.participant_count,
          });
        }
      }
    }
  } catch {}

  // 3. Fallback to env.GROUP_ID if set
  if (groupsMap.size === 0 && env.GROUP_ID) {
    const items = env.GROUP_ID.split(',').map((s: string) => s.trim()).filter(Boolean);
    for (const item of items) {
      groupsMap.set(item, {
        jid: item,
        subject: item.includes('@g.us') ? `Configured Group (${item.slice(0, 10)}...)` : item,
      });
    }
  }

  // Populate message statistics for active groups only
  if (groupsMap.size > 0) {
    try {
      const activeJids = Array.from(groupsMap.keys());
      const rows = await query<{ jid: string; count: string; last_msg: string }>(
        `SELECT 
           group_id as jid,
           COUNT(*)::text as count,
           MAX(timestamp)::text as last_msg
         FROM messages
         WHERE group_id = ANY($1)
         GROUP BY group_id`,
        [activeJids]
      );
      for (const r of rows) {
        const existing = groupsMap.get(r.jid);
        if (existing) {
          existing.message_count = parseInt(r.count, 10) || 0;
          existing.last_activity = r.last_msg;
        }
      }
    } catch {}
  }

  return Array.from(groupsMap.values());
}

// ── Bot Status & Mode ──────────────────────────────────────────
app.get('/status', async (_req: Request, res: Response) => {
  try {
    const lastSync = await getLastSyncTimestamp();
    const lastSyncMins = lastSync ? (Date.now() - lastSync.getTime()) / 60000 : null;
    const isWorking = lastSyncMins !== null && lastSyncMins < 60;

    const groupsList = await getGroupsFromDatabase();

    const stats = await query<{ total_messages: number; total_chunks: number; total_answers: number }>(
      `SELECT
         (SELECT count(*)::int FROM messages) as total_messages,
         (SELECT count(*)::int FROM chunks) as total_chunks,
         (SELECT count(*)::int FROM answers) as total_answers`
    );
    const s = stats[0] || { total_messages: 0, total_chunks: 0, total_answers: 0 };

    res.json({
      bot_name: 'Zeus Bot',
      status: isWorking ? 'working' : 'sleeping',
      mode: 'active',
      active_groups_count: groupsList.length,
      groups: groupsList,
      total_messages: s.total_messages ?? 0,
      total_chunks: s.total_chunks ?? 0,
      total_answers: s.total_answers ?? 0,
      last_message_at: lastSync?.toISOString() ?? null,
      uptime_seconds: process.uptime(),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch status');
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ── Groups management ──────────────────────────────────────────
app.get('/groups', async (_req: Request, res: Response) => {
  try {
    const groups = await getGroupsFromDatabase();
    res.json({ count: groups.length, groups });
  } catch {
    res.json({ count: 0, groups: [] });
  }
});

app.post('/groups/add', async (req: Request, res: Response) => {
  const { invite_link } = req.body;
  if (!invite_link) {
    return res.status(400).json({ error: 'invite_link is required' });
  }

  try {
    const response = await fetch(`http://localhost:${env.INGESTION_PORT}/join-group`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite_link }),
    });
    const result = await response.json();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, message: `Could not reach Ingestion service to join group: ${msg}` });
  }
});

app.post('/restart', async (_req: Request, res: Response) => {
  try {
    const response = await fetch(`http://localhost:${env.INGESTION_PORT}/restart`, {
      method: 'POST',
    });
    const result = await response.json();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, message: `Could not reach Ingestion service to restart: ${msg}` });
  }
});

// ── Catch-Up ("What did I miss?") ──────────────────────────────
app.get('/catchup', async (req: Request, res: Response) => {
  try {
    const timeframe = (req.query.timeframe as string) || 'today';
    const group_id = req.query.group_id as string | undefined;
    const user_name = req.query.user_name as string | undefined;

    let hours = 24;
    let label = 'today';
    if (timeframe === 'yesterday') {
      hours = 48;
      label = 'yesterday';
    } else if (timeframe === 'this_week') {
      hours = 168;
      label = 'this week';
    }

    const { getCatchUpChunks } = await import('@unipods/shared/src/retrieval');
    const { generateCatchUp } = await import('@unipods/shared/src/llm');

    const chunks = await getCatchUpChunks(group_id, hours, 50);
    const catchup = await generateCatchUp(label, chunks, user_name);

    res.json(catchup);
  } catch (err) {
    logger.error({ err }, 'Error generating catch-up');
    res.status(500).json({ error: 'Failed to generate catch-up' });
  }
});

// ── Meetings Intelligence ──────────────────────────────────────
app.get('/meetings', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ call_id: string; title: string; count: number; latest_date: string }>(
      `SELECT
         COALESCE(metadata->>'call_id', 'Call') as call_id,
         COALESCE(metadata->>'title', 'Team Meeting') as title,
         COUNT(*) as count,
         MAX(created_at) as latest_date
       FROM chunks
       WHERE source_type = 'transcript'
       GROUP BY 1, 2
       ORDER BY latest_date DESC`
    );
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

app.get('/meetings/:callId', async (req: Request, res: Response) => {
  try {
    const { callId } = req.params;
    const { getMeetingChunks } = await import('@unipods/shared/src/retrieval');
    const { generateMeetingIntelligence } = await import('@unipods/shared/src/llm');

    const chunks = await getMeetingChunks(callId);
    const intelligence = await generateMeetingIntelligence(callId, chunks);
    res.json(intelligence);
  } catch (err) {
    res.status(500).json({ error: 'Failed to analyze meeting' });
  }
});

// ── File & Source Ingestion ────────────────────────────────────
app.post('/ingest/file', async (req: Request, res: Response) => {
  try {
    const { title, content, type = 'DOCUMENT', author = 'Admin', group_id } = req.body;
    if (!content || !title) {
      return res.status(400).json({ error: 'title and content are required' });
    }

    const { ingestMessage } = await import('@unipods/shared/src/ingest');
    const sourceType = type === 'MEETING_TRANSCRIPT' ? 'call_transcript' : 'document';

    const messageId = await ingestMessage({
      sender: author,
      sender_name: author,
      timestamp: new Date(),
      text: `[${title}]\n\n${content}`,
      source: sourceType,
      media_url: null,
      media_type: null,
      reply_to: null,
      group_id: group_id || '',
      is_admin: true,
      metadata: {
        title,
        type,
        ingested_at: new Date().toISOString(),
      },
    });

    res.json({ success: true, messageId, title, type });
  } catch (err) {
    logger.error({ err }, 'Ingestion failed');
    res.status(500).json({ error: 'Ingestion failed' });
  }
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

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : env.ANSWER_SERVICE_PORT;
app.listen(port, () => {
  logger.info(`🤖 Answer service running on port ${port}`);
  logger.info(`📬 Webhook: POST /webhook`);
  logger.info(`   Group mode: @mention the bot in the group to trigger answers`);
  logger.info(`   DM mode: message the bot number directly`);
});

export { app };
