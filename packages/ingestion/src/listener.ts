import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WAMessage,
  proto,
  GroupMetadata,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { updateLatestQr } from './index';
import { ingestMessage } from '@unipods/shared';
import getEnv from '@unipods/shared/src/config';
import { Message } from '@unipods/shared/src/types';

const logger = pino({ level: 'info' });
const AUTH_DIR = path.resolve(__dirname, '../../.baileys-auth');

// Admin cache: groupJid → Set of admin participant JIDs
// Refreshed on connect and whenever group membership changes.
const adminCache = new Map<string, Set<string>>();

// Track sent message IDs to prevent self-reply loops
const sentMessageIds = new Set<string>();

// Ensure auth directory exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let retryCount = 0;
const MAX_RETRIES = 5;

export async function startBaileysListener(): Promise<void> {
  const env = getEnv();
  let targetGroupJids = new Set<string>();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  logger.info(`🟢 Baileys version: ${version.join('.')} | Latest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: ['Ubuntu', 'Chrome', '126.0.0.0'],
    markOnlineOnConnect: true,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    syncFullHistory: false,
    getMessage: async () => undefined,
  });

  // ── Credential persistence ────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Connection management ─────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=================== WHATSAPP QR CODE ===================');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('========================================================\n');
      logger.info('📱 Scan the QR code above or open http://localhost:3002/qr in your browser!');

      QRCode.toDataURL(qr, (err, url) => {
        if (!err && url) {
          updateLatestQr(url);
        }
      });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(`Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        retryCount++;
        const delay = Math.min(2000 * Math.pow(1.5, Math.min(retryCount, 10)), 30000);
        logger.info(`Reconnecting in ${Math.round(delay)}ms (attempt ${retryCount})...`);
        setTimeout(() => startBaileysListener(), delay);
      } else {
        logger.error('❌ Logged out. Delete auth folder and restart to re-pair.');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        process.exit(1);
      }
    }

    if (connection === 'open') {
      retryCount = 0;
      updateLatestQr(null);
      logger.info('✅ WhatsApp connection established');

      let groups: Record<string, GroupMetadata> = {};
      try {
        groups = await sock.groupFetchAllParticipating();
        console.log('\n=================== YOUR WHATSAPP GROUPS ===================');
        for (const [id, meta] of Object.entries(groups)) {
          console.log(`📌 Group Name: "${meta.subject}"`);
          console.log(`   ID: ${id}\n`);
        }
        console.log('============================================================\n');
      } catch (err) {
        logger.warn({ err }, 'Could not fetch group list on startup');
      }

      if (env.GROUP_ID) {
        targetGroupJids = await resolveTargetGroups(sock, env.GROUP_ID, groups);
      } else {
        targetGroupJids = new Set();
      }

      const monitoredList = targetGroupJids.size > 0
        ? Array.from(targetGroupJids).join(', ')
        : '⚠️ ALL GROUPS (Set GROUP_ID in .env to target specific groups)';

      logger.info(`📡 Currently monitoring groups: ${monitoredList}`);

      for (const jid of targetGroupJids) {
        await refreshAdminCache(sock, jid);
      }
    }
  });

  // ── Keep admin cache fresh when group membership changes ──────
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action === 'promote' || action === 'demote' || action === 'add' || action === 'remove') {
      logger.info({ groupId: id, action, count: participants.length }, '🔄 Group membership change — refreshing admin cache');
      await refreshAdminCache(sock, id);
    }
  });

  // ── Message ingestion ─────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logger.info({ type, count: messages.length }, '📩 Raw messages.upsert event received');

    for (const msg of messages) {
      try {
        await processMessage(msg, targetGroupJids, sock);
      } catch (err) {
        logger.error({ err, msgId: msg.key.id }, 'Failed to process message');
      }
    }
  });

  return;
}

// ─────────────────────────────────────────────────────────────────────────────
// Group Target Resolver Helper
// ─────────────────────────────────────────────────────────────────────────────

async function resolveTargetGroups(
  sock: ReturnType<typeof makeWASocket>,
  rawInput: string,
  groups: Record<string, GroupMetadata>
): Promise<Set<string>> {
  const targetJids = new Set<string>();
  if (!rawInput || !rawInput.trim()) return targetJids;

  const items = rawInput.split(',').map((s) => s.trim()).filter(Boolean);

  for (const item of items) {
    if (item.endsWith('@g.us')) {
      targetJids.add(item);
      continue;
    }

    if (item.includes('chat.whatsapp.com/')) {
      try {
        const code = item.split('chat.whatsapp.com/')[1].split('?')[0].split('/')[0];
        const info = await sock.groupGetInviteInfo(code);
        if (info && info.id) {
          logger.info({ name: info.subject, id: info.id }, '🔗 Resolved group invite link to Group JID');
          targetJids.add(info.id);
          continue;
        }
      } catch (err) {
        logger.warn({ err, item }, 'Failed to resolve group invite link');
      }
    }

    let matched = false;
    for (const [id, meta] of Object.entries(groups)) {
      if (
        meta.subject.trim().toLowerCase() === item.toLowerCase() ||
        meta.subject.trim().toLowerCase().includes(item.toLowerCase())
      ) {
        logger.info({ name: meta.subject, id }, '🎯 Matched group name to Group JID');
        targetJids.add(id);
        matched = true;
      }
    }

    if (!matched) {
      logger.warn({ item }, '⚠️ Could not resolve group setting to a known group JID');
    }
  }

  return targetJids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin cache helpers
// ─────────────────────────────────────────────────────────────────────────────

async function refreshAdminCache(
  sock: ReturnType<typeof makeWASocket>,
  groupJid: string
): Promise<void> {
  try {
    const meta: GroupMetadata = await sock.groupMetadata(groupJid);
    const admins = new Set(
      meta.participants
        .filter((p) => p.admin === 'admin' || p.admin === 'superadmin')
        .map((p) => p.id)
    );
    adminCache.set(groupJid, admins);
    logger.info(
      { groupJid, adminCount: admins.size, admins: [...admins] },
      '🛁 Admin cache refreshed'
    );
  } catch (err) {
    logger.warn({ err, groupJid }, 'Could not fetch group metadata for admin cache');
  }
}

async function processMessage(
  msg: WAMessage,
  targetGroupJids: Set<string>,
  sock: ReturnType<typeof makeWASocket>
): Promise<void> {
  const env = getEnv();

  // Skip messages sent by our bot itself to prevent infinite loops
  if (msg.key.id && sentMessageIds.has(msg.key.id)) {
    return;
  }

  const jid = msg.key.remoteJid ?? '';
  const isGroup = jid.endsWith('@g.us');
  const isDM = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

  logger.info(
    { jid, isGroup, isDM, fromMe: msg.key.fromMe, hasMessage: !!msg.message },
    '🔍 Evaluating incoming message in processMessage'
  );

  if (!isGroup && !isDM) return;

  // Extract message content
  const msgContent = msg.message;
  if (!msgContent) return;

  const text = extractText(msgContent);

  logger.info({ jid, fromMe: msg.key.fromMe, text }, '💬 Extracted message text');

  // Skip messages sent by this bot number itself (never answer outgoing DMs or outgoing group replies)
  if (msg.key.fromMe && (isDM || !text || !text.toLowerCase().includes('@bot'))) return;

  // Skip empty messages (stickers, etc.)
  if (!text && !hasMedia(msgContent)) return;

  const sender = msg.key.participant ?? msg.key.remoteJid ?? '';
  const pushName = (msg as unknown as Record<string, unknown>).pushName as string | undefined;
  const senderName = pushName && pushName.trim() ? pushName : 'User';
  const timestamp = new Date((msg.messageTimestamp as number) * 1000);
  const replyTo = msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null;

  // ── DM mode: answer direct WhatsApp messages automatically ──────────────
  if (isDM && text) {
    logger.info({ question: text, senderName, jid }, '📩 Direct Message (DM) received — generating answer');
    askAndReplyInGroup({
      question: text,
      senderName,
      groupJid: jid,
      quotedMsg: msg,
      sock,
    }).catch((err) => logger.error({ err }, 'Failed to reply to DM'));
    return; // Private DMs are answered directly without polluting group memory DB
  }

  // ── Admin detection ───────────────────────────────────────────
  if (!adminCache.has(jid)) {
    await refreshAdminCache(sock, jid);
  }
  const groupAdmins = adminCache.get(jid) ?? new Set<string>();
  const isAdmin = groupAdmins.has(sender);

  if (isAdmin) {
    logger.info({ sender: senderName, groupId: jid }, '沐 Admin message received');
  }

  // ── @mention detection (bot responding in-group via answer service) ───────
  const botPhone = env.WHATSAPP_PHONE_NUMBER_ID;
  const isMentionedBot =
    text &&
    (
      (botPhone && text.includes(`@${botPhone}`)) ||
      text.toLowerCase().includes('@bot') ||
      (msgContent.extendedTextMessage?.contextInfo?.mentionedJid ?? []).some(
        (id) => botPhone && id.replace('@s.whatsapp.net', '') === botPhone
      )
    );

  if (isMentionedBot && text) {
    // Strip the @mention to get the clean question
    const question = text
      .replace(new RegExp(`@${botPhone || ''}`, 'g'), '')
      .replace(/@bot/gi, '')
      .trim();

    logger.info({ question, senderName, groupId: jid }, '🤖 Bot @mentioned — generating answer via Baileys reply');

    // Answer and reply directly in the group
    askAndReplyInGroup({
      question,
      senderName,
      groupJid: jid,
      quotedMsg: msg,
      sock,
    }).catch((err) => logger.error({ err }, 'Failed to answer @mention'));
  }

  // ── Group ingestion filter ─────────────────────────────────────
  // Only store group messages into database for target groups (or all groups if targetGroupJids is empty)
  if (isGroup && targetGroupJids.size > 0 && !targetGroupJids.has(jid)) {
    logger.info({ jid }, '⏭️ Skipping background DB ingestion for non-target group');
    return;
  }

  const mediaInfo = extractMedia(msgContent);

  logger.info(
    { sender: senderName, isAdmin, groupId: jid, textLen: text?.length ?? 0 },
    '📨 New group message received'
  );

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
    is_admin: isAdmin,
    metadata: {
      is_question: text ? isQuestion(text) : false,
      msg_type: getMsgType(msgContent),
      jid,
    },
  };

  // Embed-on-receipt: synchronous, no batching
  const messageId = await ingestMessage(messagePayload);
  logger.info({ messageId, isAdmin }, '✅ Message embedded and stored');
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
  content: proto.IMessage
): { url: string | null; type: string | null } {
  if (content.imageMessage) return { url: null, type: 'image' };
  if (content.videoMessage) return { url: null, type: 'video' };
  if (content.audioMessage) return { url: null, type: 'audio' };
  if (content.documentMessage) return { url: null, type: 'document' };
  return { url: null, type: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Answer and reply directly in-group via Baileys (no Meta Cloud API needed)
// ─────────────────────────────────────────────────────────────────────────────

async function askAndReplyInGroup({
  question,
  senderName,
  groupJid,
  quotedMsg,
  sock,
}: {
  question: string;
  senderName: string;
  groupJid: string;
  quotedMsg: WAMessage;
  sock: ReturnType<typeof makeWASocket>;
}): Promise<void> {
  const env = getEnv();

  // Call the answer service locally to get the answer
  const answerServiceUrl = `http://localhost:${env.ANSWER_SERVICE_PORT}/ask`;
  const res = await fetch(answerServiceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, user_name: senderName, group_id: groupJid }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Answer service error ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    answer: string;
    confidence: string;
    is_duplicate_question: boolean;
  };

  // Format the reply (mirror the Cloud API formatting)
  let reply = '';

  // Address the person who asked
  reply += `@${senderName}\n\n`;

  if (data.confidence === 'insufficient') {
    reply += '❓ ';
  } else if (data.confidence === 'low') {
    reply += '⚠️ *Partial info* — I may not have the full picture:\n\n';
  }

  reply += data.answer;

  if (data.is_duplicate_question) {
    reply += '\n\n📌 _This was asked before — check earlier in the chat for more context._';
  }

  // Send reply into the group as a quoted reply to the original message
  const sent = await sock.sendMessage(
    groupJid,
    { text: reply.slice(0, 4000) }, // WhatsApp max ~4096 chars
    { quoted: quotedMsg }
  );

  if (sent?.key?.id) {
    sentMessageIds.add(sent.key.id);
    setTimeout(() => {
      if (sent.key.id) sentMessageIds.delete(sent.key.id);
    }, 60000);
  }

  // Ingest bot reply to memory for multi-turn thread context
  ingestMessage({
    sender: 'bot',
    sender_name: 'UniPods Bot',
    timestamp: new Date(),
    text: data.answer,
    source: 'whatsapp',
    media_url: null,
    media_type: null,
    reply_to: quotedMsg.key.id ?? null,
    group_id: groupJid,
    is_admin: true,
    metadata: {
      is_question: false,
      msg_type: 'text',
      jid: groupJid,
    },
  }).catch((err) => logger.warn({ err }, 'Could not ingest bot answer into thread memory'));

  logger.info({ groupJid, confidence: data.confidence }, '✅ Baileys in-group reply sent');
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
