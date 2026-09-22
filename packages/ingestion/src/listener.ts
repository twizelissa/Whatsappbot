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
import { ingestMessage, detectGroupConfusion, Message, GroupInfo } from '@unipods/shared';

function getEnv() {
  const shared = require('@unipods/shared');
  return shared.getEnv();
}

const logger = pino({ level: 'info' });
const AUTH_DIR = path.resolve(__dirname, '../../.baileys-auth');
const ACTIVE_GROUPS_FILE = path.resolve(AUTH_DIR, 'active_groups.json');

// Admin cache: groupJid → Set of admin participant JIDs
const adminCache = new Map<string, Set<string>>();

// Track sent message IDs to prevent self-reply loops
const sentMessageIds = new Set<string>();

// Global WhatsApp socket reference for dynamic calls
let globalSock: ReturnType<typeof makeWASocket> | null = null;

// Store participating groups metadata: groupJid → GroupInfo
const participatingGroups = new Map<string, GroupInfo>();

// Active groups map: groupJid → GroupInfo (ONLY groups where Zeus is explicitly activated or joined via dashboard)
const activeGroupsMap = new Map<string, GroupInfo>();

// Rolling buffer of recent group messages for confusion detection: groupJid → array of recent msgs
const recentGroupMessages = new Map<string, { sender_name: string; text: string; timestamp: Date }[]>();

// Track last confusion intervention timestamp per group to prevent spamming
const lastInterventionTime = new Map<string, number>();

// Ensure auth directory exists
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Load active groups from disk
function loadActiveGroups(): void {
  try {
    if (fs.existsSync(ACTIVE_GROUPS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACTIVE_GROUPS_FILE, 'utf-8')) as GroupInfo[];
      activeGroupsMap.clear();
      for (const g of data) {
        if (g.jid && g.is_active) {
          activeGroupsMap.set(g.jid, g);
        }
      }
      logger.info({ count: activeGroupsMap.size }, '📂 Loaded active groups from disk');
    }
  } catch (err) {
    logger.warn({ err }, 'Could not load active_groups.json file');
  }
}

// Save active groups to disk
function saveActiveGroups(): void {
  try {
    const list = Array.from(activeGroupsMap.values()).filter((g) => g.is_active);
    fs.writeFileSync(ACTIVE_GROUPS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'Could not save active_groups.json file');
  }
}

loadActiveGroups();

let retryCount = 0;

export function getActiveGroupsInfo(): GroupInfo[] {
  return Array.from(activeGroupsMap.values()).filter((g) => g.is_active);
}

export async function joinGroup(inviteCodeOrLink: string): Promise<{ success: boolean; groupJid?: string; message: string }> {
  if (!globalSock) {
    return { success: false, message: 'WhatsApp bot is not connected yet.' };
  }

  try {
    let code = inviteCodeOrLink.trim();
    if (code.includes('chat.whatsapp.com/')) {
      code = code.split('chat.whatsapp.com/')[1].split('?')[0].split('/')[0];
    }

    const response = await globalSock.groupAcceptInvite(code);
    if (response) {
      logger.info({ response, code }, '⚡ Zeus Bot joined group via invite link');
      const meta = await globalSock.groupMetadata(response);
      const groupInfo: GroupInfo = {
        jid: response,
        subject: meta.subject || 'New Group',
        participant_count: meta.participants.length,
        joined_at: new Date().toISOString(),
        is_active: true,
      };
      participatingGroups.set(response, groupInfo);
      activeGroupsMap.set(response, groupInfo);
      saveActiveGroups();

      // Send greeting in group
      try {
        await globalSock.sendMessage(response, {
          text: `⚡ *Zeus Bot is now ACTIVE in this group!* 🚀\n\nI am your WhatsApp Group Memory & Intelligence Assistant. Tag me with *@zeus* or type *zeus [question]* anytime to get instant answers!`,
        });
      } catch {}

      return { success: true, groupJid: response, message: `Successfully joined & activated Zeus Bot in "${meta.subject}"!` };
    }
    return { success: false, message: 'Could not accept group invite.' };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to join group via invite link');
    return { success: false, message: `Failed to join group: ${errorMsg}` };
  }
}

export async function restartBaileysListener(): Promise<{ success: boolean; message: string }> {
  try {
    logger.info('🔄 Restarting Baileys WhatsApp connection...');
    if (globalSock) {
      try {
        globalSock.ev.removeAllListeners('connection.update');
        globalSock.ev.removeAllListeners('messages.upsert');
        globalSock.end(undefined);
      } catch {}
      globalSock = null;
    }
    setTimeout(() => {
      startBaileysListener().catch((err) => logger.error({ err }, 'Failed to restart Baileys listener'));
    }, 1000);
    return { success: true, message: 'Zeus Bot connection is restarting and re-synchronizing...' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Restart failed: ${msg}` };
  }
}

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

  sock.ev.on('creds.update', saveCreds);

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

    globalSock = sock;

    if (connection === 'open') {
      retryCount = 0;
      updateLatestQr(null);
      logger.info('✅ WhatsApp connection established for Zeus Bot');

      let groups: Record<string, GroupMetadata> = {};
      try {
        groups = await sock.groupFetchAllParticipating();
        participatingGroups.clear();
        for (const [id, meta] of Object.entries(groups)) {
          const isConfiguredOrActive = activeGroupsMap.has(id);
          participatingGroups.set(id, {
            jid: id,
            subject: meta.subject || 'WhatsApp Group',
            participant_count: meta.participants?.length ?? 0,
            joined_at: new Date().toISOString(),
            is_active: isConfiguredOrActive,
          });
        }
      } catch (err) {
        logger.warn({ err }, 'Could not fetch group list on startup');
      }

      if (env.GROUP_ID) {
        targetGroupJids = await resolveTargetGroups(sock, env.GROUP_ID, groups);
        for (const jid of targetGroupJids) {
          const meta = groups[jid];
          activeGroupsMap.set(jid, {
            jid,
            subject: meta?.subject || 'WhatsApp Group',
            participant_count: meta?.participants?.length ?? 0,
            is_active: true,
          });
        }
        saveActiveGroups();
      }

      logger.info(`📡 Zeus Bot running. Active Groups count: ${activeGroupsMap.size}`);
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action === 'promote' || action === 'demote' || action === 'add' || action === 'remove') {
      logger.info({ groupId: id, action, count: participants.length }, '🔄 Group membership change — refreshing admin cache');
      await refreshAdminCache(sock, id);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        await processMessage(msg, sock);
      } catch (err) {
        logger.error({ err, msgId: msg.key.id }, 'Failed to process message');
      }
    }
  });

  return;
}

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
          targetJids.add(info.id);
          continue;
        }
      } catch (err) {
        logger.warn({ err, item }, 'Failed to resolve group invite link');
      }
    }

    for (const [id, meta] of Object.entries(groups)) {
      if (
        meta.subject.trim().toLowerCase() === item.toLowerCase() ||
        meta.subject.trim().toLowerCase().includes(item.toLowerCase())
      ) {
        targetJids.add(id);
      }
    }
  }

  return targetJids;
}

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
  } catch (err) {
    logger.warn({ err, groupJid }, 'Could not fetch group metadata for admin cache');
  }
}

async function processMessage(
  msg: WAMessage,
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

  if (!isGroup && !isDM) return;

  const msgContent = msg.message;
  if (!msgContent) return;

  const text = extractText(msgContent);
  const lowerText = text ? text.toLowerCase().trim() : '';

  // Skip outgoing messages unless user explicitly mentioned zeus or sent a DM test
  if (msg.key.fromMe && (!text || (!/zeus|@zeus|@bot/i.test(text) && !isDM))) return;

  if (!text && !hasMedia(msgContent)) return;

  const sender = msg.key.participant ?? msg.key.remoteJid ?? '';
  const pushName = (msg as unknown as Record<string, unknown>).pushName as string | undefined;
  const senderName = pushName && pushName.trim() ? pushName : 'User';
  const timestamp = new Date((msg.messageTimestamp as number) * 1000);
  const replyTo = msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null;

  // ── Explicit Zeus Activation / Deactivation Commands ───────────────────────
  if (isGroup && text) {
    const isStartCmd = /^(zeus\s+start|@zeus\s+start|zeus\s+activate|activate\s+zeus|zeus\s+on)$/i.test(lowerText);
    const isStopCmd = /^(zeus\s+stop|@zeus\s+stop|zeus\s+pause|pause\s+zeus|zeus\s+off)$/i.test(lowerText);

    if (isStartCmd) {
      let groupSubject = 'WhatsApp Group';
      try {
        const meta = await sock.groupMetadata(jid);
        groupSubject = meta.subject || groupSubject;
      } catch {}

      activeGroupsMap.set(jid, {
        jid,
        subject: groupSubject,
        participant_count: 0,
        joined_at: new Date().toISOString(),
        is_active: true,
      });
      saveActiveGroups();

      logger.info({ jid, subject: groupSubject }, '⚡ Zeus Bot explicitly ACTIVATED in group');

      await sendDirectReply(sock, jid, `⚡ *Zeus Bot is now ACTIVE in this group!* 🚀\n\nI will monitor group memory and answer questions whenever tagged with *@zeus* or *zeus*.`, msg);
      return;
    }

    if (isStopCmd) {
      activeGroupsMap.delete(jid);
      saveActiveGroups();

      logger.info({ jid }, '🌙 Zeus Bot explicitly PAUSED in group');

      await sendDirectReply(sock, jid, `🌙 *Zeus Bot is now PAUSED for this group.* 💤\n\nI have stopped active memory ingestion here. Type *zeus start* anytime to reactivate!`, msg);
      return;
    }
  }

  // ── Direct Message (DM) Handling ──────────────────────────────────────────
  if (isDM && text) {
    logger.info({ question: text, senderName, jid }, '📩 Direct Message (DM) received — Zeus generating answer');
    askAndReplyInGroup({
      question: text,
      senderName,
      groupJid: jid,
      quotedMsg: msg,
      sock,
    }).catch((err) => logger.error({ err }, 'Failed to reply to DM'));
    return;
  }

  // ── Group Message Handling ────────────────────────────────────────────────
  // Check if group is active (either via zeus start, active_groups.json, or env GROUP_ID)
  const isGroupActive = activeGroupsMap.has(jid) || (env.GROUP_ID && env.GROUP_ID.includes(jid));

  // Zeus Bot Mention / Tag Detection
  const botPhone = env.WHATSAPP_PHONE_NUMBER_ID;
  const isMentionedBot =
    text &&
    (
      lowerText.includes('zeus') ||
      lowerText.includes('@zeus') ||
      lowerText.includes('zeus_bot') ||
      lowerText.includes('@zeus_bot') ||
      lowerText.includes('@bot') ||
      (botPhone && text.includes(`@${botPhone}`)) ||
      (msgContent.extendedTextMessage?.contextInfo?.mentionedJid ?? []).some(
        (id) => botPhone && id.replace('@s.whatsapp.net', '') === botPhone
      )
    );

  if (isMentionedBot && text) {
    // If tagged in an inactive group, auto-activate it!
    if (isGroup && !isGroupActive) {
      let groupSubject = 'WhatsApp Group';
      try {
        const meta = await sock.groupMetadata(jid);
        groupSubject = meta.subject || groupSubject;
      } catch {}

      activeGroupsMap.set(jid, {
        jid,
        subject: groupSubject,
        participant_count: 0,
        joined_at: new Date().toISOString(),
        is_active: true,
      });
      saveActiveGroups();
    }

    const question = text
      .replace(/@zeus_bot/gi, '')
      .replace(/zeus_bot/gi, '')
      .replace(/@zeus/gi, '')
      .replace(/\bzeus\b/gi, '')
      .replace(/@bot/gi, '')
      .replace(new RegExp(`@${botPhone || ''}`, 'g'), '')
      .trim();

    logger.info({ question, senderName, groupId: jid }, '⚡ Zeus Bot tagged — generating answer');

    askAndReplyInGroup({
      question: question || text,
      senderName,
      groupJid: jid,
      quotedMsg: msg,
      sock,
    }).catch((err) => logger.error({ err }, 'Failed to answer Zeus tag'));
  } else if (isGroup && text && isGroupActive) {
    // ── Proactive Confusion Intervention (Active Groups Only) ───────────────
    const buffer = recentGroupMessages.get(jid) ?? [];
    buffer.push({ sender_name: senderName, text, timestamp });
    if (buffer.length > 8) buffer.shift();
    recentGroupMessages.set(jid, buffer);

    const now = Date.now();
    const lastTime = lastInterventionTime.get(jid) ?? 0;
    if (now - lastTime > 300000 && buffer.length >= 2) {
      detectGroupConfusion(buffer).then((assessment: any) => {
        if (assessment.is_confused && assessment.confidence >= 0.7 && assessment.suggested_answer_query) {
          logger.info({ assessment, jid }, '⚡ Zeus Bot detected group confusion — stepping in proactively!');
          lastInterventionTime.set(jid, now);
          askAndReplyInGroup({
            question: assessment.suggested_answer_query,
            senderName: 'Group',
            groupJid: jid,
            quotedMsg: msg,
            sock,
          }).catch((err: any) => logger.error({ err }, 'Failed to post proactive intervention'));
        }
      }).catch((err: any) => logger.warn({ err }, 'Confusion detection check error'));
    }
  }

  // Only ingest background group memory for ACTIVE groups
  if (isGroup && !isGroupActive) {
    return;
  }

  // ── Admin detection & DB Ingestion ─────────────────────────────────────────
  if (!adminCache.has(jid)) {
    await refreshAdminCache(sock, jid);
  }
  const groupAdmins = adminCache.get(jid) ?? new Set<string>();
  const isAdmin = groupAdmins.has(sender);

  const mediaInfo = extractMedia(msgContent);

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

  const messageId = await ingestMessage(messagePayload);
  logger.info({ messageId, isAdmin, jid }, '✅ Message ingested to memory');
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

async function sendDirectReply(
  sock: ReturnType<typeof makeWASocket>,
  jid: string,
  text: string,
  quotedMsg?: WAMessage
): Promise<void> {
  try {
    const isLid = jid.endsWith('@lid');
    const isFromMe = quotedMsg?.key?.fromMe ?? false;
    const shouldQuote = quotedMsg && !isLid && !isFromMe;
    const options = shouldQuote ? { quoted: quotedMsg } : {};

    const sent = await sock.sendMessage(jid, { text }, options);
    if (sent?.key?.id) {
      sentMessageIds.add(sent.key.id);
      setTimeout(() => sentMessageIds.delete(sent.key.id!), 60000);
      logger.info({ jid, textLen: text.length, isLid }, '✅ Direct reply successfully sent via WhatsApp');
    }
  } catch (err) {
    logger.warn({ err, jid }, '⚠️ Failed sending direct reply with quote, attempting unquoted fallback...');
    try {
      const sent = await sock.sendMessage(jid, { text });
      if (sent?.key?.id) {
        sentMessageIds.add(sent.key.id);
        setTimeout(() => sentMessageIds.delete(sent.key.id!), 60000);
        logger.info({ jid, textLen: text.length }, '✅ Direct reply successfully sent (unquoted fallback)');
      }
    } catch (fallbackErr) {
      logger.error({ err: fallbackErr, jid }, '❌ Failed to send direct reply to user');
    }
  }
}

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

  const answerServiceUrl = `http://localhost:${env.ANSWER_SERVICE_PORT}/ask`;
  let data: { answer: string; confidence: string; is_duplicate_question: boolean } | null = null;

  try {
    const res = await fetch(answerServiceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, user_name: senderName, group_id: groupJid }),
    });

    if (res.ok) {
      data = (await res.json()) as any;
    } else {
      const errText = await res.text();
      logger.error({ status: res.status, errText }, 'Answer service returned error HTTP status');
    }
  } catch (err) {
    logger.warn({ err }, 'Answer service HTTP endpoint not reachable — falling back to direct in-process Q&A');
  }

  // Direct in-process fallback if HTTP service is not running
  if (!data) {
    try {
      const {
        getLastSyncTimestamp,
        findDuplicateQuestion,
        getRecentChunks,
        hybridSearch,
        getRecentThreadHistory,
        generateAnswer,
      } = await import('@unipods/shared');

      const lastSync = await getLastSyncTimestamp();
      const freshnessMins = lastSync ? (Date.now() - lastSync.getTime()) / 60000 : undefined;

      const dup = env.ENABLE_DUPLICATE_DETECTION === 'true'
        ? await findDuplicateQuestion(question)
        : null;

      const isSummaryQuery = /^\s*(summarize|summary|summaries|digest|overview|recap|recent chat|recent messages|what happened|what's new)/i.test(question);
      const targetGroup = groupJid || env.GROUP_ID || undefined;

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
        freshnessMins,
        userName: senderName,
        conversationHistory,
      });

      data = {
        answer: answerResult.answer,
        confidence: answerResult.confidence,
        is_duplicate_question: !!dup,
      };
    } catch (directErr) {
      logger.error({ directErr }, 'Direct Q&A fallback failed');
    }
  }

  let reply = '';
  if (senderName && senderName !== 'User' && senderName !== 'Group') {
    reply += `@${senderName}\n\n`;
  }

  if (!data) {
    reply += '⚡ *Zeus Bot*: I received your query! I ran into a temporary issue retrieving memory context, but I am online and listening. Please try asking again!';
  } else {
    if (data.confidence === 'insufficient') {
      reply += '❓ ';
    } else if (data.confidence === 'low') {
      reply += '⚠️ *Partial info* — I may not have the full picture:\n\n';
    }

    reply += data.answer;

    if (data.is_duplicate_question) {
      reply += '\n\n📌 _This was asked before — check earlier in the chat for more context._';
    }
  }

  await sendDirectReply(sock, groupJid, reply.slice(0, 4000), quotedMsg);

  if (data?.answer) {
    ingestMessage({
      sender: 'bot',
      sender_name: 'Zeus Bot',
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
    }).catch(() => {});
  }
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

function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.endsWith('?') ||
    /^(what|when|where|who|why|how|is|are|was|were|did|does|do|can|could|should|would|has|have)/i.test(trimmed)
  );
}
