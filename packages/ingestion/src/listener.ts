import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WAMessage,
  proto,
  AnyMessageContent,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { ingestMessage } from '@unipods/shared';
import getEnv from '@unipods/shared/src/config';
import { Message } from '@unipods/shared/src/types';

const logger = pino({ level: 'info' });
const AUTH_DIR = path.resolve(__dirname, '../../.baileys-auth');

// Ensure auth directory exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let retryCount = 0;
const MAX_RETRIES = 5;

export async function startBaileysListener(): Promise<void> {
  const env = getEnv();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  logger.info(`🟢 Baileys version: ${version.join('.')} | Latest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }), // suppress internal Baileys logs in prod
    printQRInTerminal: true,           // shows QR on first run
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: ['UniPods Bot', 'Chrome', '126.0'],
    markOnlineOnConnect: false,         // stay low-profile
    syncFullHistory: false,
    getMessage: async () => undefined,  // don't retry old messages
  });

  // ── Credential persistence ────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Connection management ─────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('📱 Scan the QR code above to link the ingestion number');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(`Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect && retryCount < MAX_RETRIES) {
        retryCount++;
        const delay = Math.min(1000 * 2 ** retryCount, 30000); // exponential backoff
        logger.info(`Reconnecting in ${delay}ms (attempt ${retryCount}/${MAX_RETRIES})...`);
        setTimeout(() => startBaileysListener(), delay);
      } else if (statusCode === DisconnectReason.loggedOut) {
        logger.error('❌ Logged out. Delete auth folder and restart to re-pair.');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        process.exit(1);
      } else {
        logger.error('❌ Max reconnect attempts reached. Exiting.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      retryCount = 0;
      logger.info('✅ WhatsApp connection established (read-only listener active)');
      logger.info(`📡 Monitoring group: ${env.GROUP_ID || 'all groups'}`);
    }
  });

  // ── Message ingestion ─────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // only process new messages, not history

    for (const msg of messages) {
      try {
        await processMessage(msg, env.GROUP_ID);
      } catch (err) {
        logger.error({ err, msgId: msg.key.id }, 'Failed to process message');
      }
    }
  });

  // ── IMPORTANT: Never send messages into the group ─────────────
  // The bot is READ-ONLY. This listener must never call sock.sendMessage
  // into the group JID. Only the answer service (Cloud API) sends replies.

  return;
}

async function processMessage(msg: WAMessage, targetGroupId: string): Promise<void> {
  const env = getEnv();

  // Only process group messages
  const jid = msg.key.remoteJid ?? '';
  if (!jid.endsWith('@g.us')) return;

  // Filter to target group if configured
  if (targetGroupId && jid !== targetGroupId) return;

  // Skip messages from us (the listener number)
  if (msg.key.fromMe) return;

  // Extract message content
  const msgContent = msg.message;
  if (!msgContent) return;

  const text = extractText(msgContent);
  const sender = msg.key.participant ?? msg.key.remoteJid ?? '';
  const senderName = (msg as unknown as Record<string, unknown>).pushName as string ?? sender.split('@')[0];
  const timestamp = new Date((msg.messageTimestamp as number) * 1000);
  const replyTo = msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null;

  // Skip empty messages (stickers, etc.)
  if (!text && !hasMedia(msgContent)) return;

  const mediaInfo = extractMedia(msgContent, msg);

  logger.info(
    { sender: senderName, groupId: jid, textLen: text?.length ?? 0 },
    '📨 New group message received'
  );

  // IMPORTANT: This check ensures read-only behavior
  // We never call sock.sendMessage here

  const messagePayload: Omit<Message, 'id'> = {
    sender,
    sender_name: senderName,
    timestamp,
    text: text ?? null,
    source: 'whatsapp',
    media_url: mediaInfo.url,
    media_type: mediaInfo.type,
    reply_to: replyTo,
    group_id: jid,
    metadata: {
      is_question: text ? isQuestion(text) : false,
      msg_type: getMsgType(msgContent),
      jid,
    },
  };

  // Embed-on-receipt: synchronous, no batching
  const messageId = await ingestMessage(messagePayload);
  logger.info({ messageId }, '✅ Message embedded and stored');
}

function extractText(content: proto.IMessage): string | null {
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null
  );
}

function hasMedia(content: proto.IMessage): boolean {
  return !!(
    content.imageMessage ||
    content.videoMessage ||
    content.audioMessage ||
    content.documentMessage
  );
}

function extractMedia(
  content: proto.IMessage,
  msg: WAMessage
): { url: string | null; type: string | null } {
  if (content.imageMessage) return { url: null, type: 'image' };
  if (content.videoMessage) return { url: null, type: 'video' };
  if (content.audioMessage) return { url: null, type: 'audio' };
  if (content.documentMessage) return { url: null, type: 'document' };
  return { url: null, type: null };
}

function getMsgType(content: proto.IMessage): string {
  if (content.conversation || content.extendedTextMessage) return 'text';
  if (content.imageMessage) return 'image';
  if (content.videoMessage) return 'video';
  if (content.audioMessage) return 'audio';
  if (content.documentMessage) return 'document';
  if (content.stickerMessage) return 'sticker';
  return 'other';
}

/**
 * Heuristic: is this message a question?
 * Used for duplicate-question detection.
 */
function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.endsWith('?') ||
    /^(what|when|where|who|why|how|is|are|was|were|did|does|do|can|could|should|would|has|have)/i.test(trimmed)
  );
}
