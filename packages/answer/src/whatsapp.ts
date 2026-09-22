import getEnv from '@unipods/shared/src/config';
import pino from 'pino';

const logger = pino({ level: 'info' });
const WHATSAPP_API_BASE = 'https://graph.facebook.com/v20.0';

export interface WhatsAppMessage {
  from: string;            // sender's phone number (DM) OR group JID (group msg)
  id: string;              // message ID
  timestamp: string;
  text?: { body: string };
  type: string;
  name?: string;           // sender display name
  // Group-specific fields
  group_id?: string;       // JID of the group (e.g. 120363xxxxxx@g.us)
  sender_in_group?: string; // actual sender's phone within a group message
  is_group?: boolean;
  is_mention?: boolean;    // was the bot @mentioned?
  clean_text?: string;     // text with @mention stripped out
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: RawWAMessage[];
        statuses?: unknown[];
      };
      field: string;
    }>;
  }>;
}

interface RawWAMessage {
  from: string;
  id: string;
  timestamp: string;
  text?: { body: string };
  type: string;
  context?: { from: string; id: string };
  // Group mentions: when the bot is @mentioned, this contains mention data
  mentions?: Array<{ wa_id: string }>;
}

/**
 * Send a text reply via WhatsApp Cloud API.
 * Works for both DMs (toPhone = phone number) and group replies (toPhone = group JID).
 * When replyToMsgId is set, the message threads under the original message.
 */
export async function sendWhatsAppReply(
  toPhone: string,
  text: string,
  replyToMsgId?: string
): Promise<void> {
  const env = getEnv();

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'text',
    text: { body: text.slice(0, 4096) }, // WA max 4096 chars
  };

  // Threading: replies appear under the original message in the group
  if (replyToMsgId) {
    body.context = { message_id: replyToMsgId };
  }

  const res = await fetch(
    `${WHATSAPP_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const error = await res.json();
    logger.error({ error, toPhone }, '❌ Failed to send WhatsApp message');
    throw new Error(`WhatsApp API error: ${JSON.stringify(error)}`);
  }

  const isGroup = toPhone.includes('@g.us') || toPhone.includes('-');
  logger.info({ toPhone, isGroup, textLen: text.length }, '✅ WhatsApp reply sent');
}

/**
 * Mark a message as read.
 */
export async function markAsRead(messageId: string): Promise<void> {
  const env = getEnv();

  await fetch(
    `${WHATSAPP_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    }
  );
}

/**
 * Parse the webhook payload.
 *
 * Handles both:
 *   - Direct messages (from = sender phone)
 *   - Group messages (from = group JID, with actual sender in contacts)
 *
 * For group messages, also detects @mention of the bot.
 */
export function parseWebhookPayload(body: unknown): {
  messages: WhatsAppMessage[];
} {
  const payload = body as WhatsAppWebhookPayload;

  if (payload.object !== 'whatsapp_business_account') {
    return { messages: [] };
  }

  const env = getEnv();
  const botPhone = env.WHATSAPP_PHONE_NUMBER_ID; // used to detect @mention
  const messages: WhatsAppMessage[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;

      const { messages: msgs, contacts, metadata } = change.value;
      if (!msgs) continue;

      for (const msg of msgs) {
        const isGroup = msg.from.includes('@g.us') || msg.from.includes('-');
        const contact = contacts?.find((c) => c.wa_id === msg.from);
        const senderName = contact?.profile.name;

        if (isGroup) {
          // Group message:
          // msg.from = group JID (e.g. "120363xxxxxx@g.us")
          // The actual sender is in contacts or msg.context
          const text = msg.text?.body ?? '';

          // Detect @mention of the bot number
          // WhatsApp sends mentions as "@<phone>" or tagged in the text
          const botDisplayPhone = metadata.display_phone_number.replace(/\D/g, '');
          const isMentioned =
            text.includes(`@${botDisplayPhone}`) ||
            text.toLowerCase().includes('@bot') ||
            (msg.mentions ?? []).some((m) => m.wa_id === botDisplayPhone);

          // Strip the @mention from text so the LLM gets a clean question
          const cleanText = text
            .replace(new RegExp(`@${botDisplayPhone}`, 'g'), '')
            .replace(/@bot/gi, '')
            .trim();

          messages.push({
            from: msg.from,        // reply TO this (the group JID)
            id: msg.id,
            timestamp: msg.timestamp,
            text: msg.text,
            type: msg.type,
            name: senderName,
            group_id: msg.from,    // same as from for groups
            is_group: true,
            is_mention: isMentioned,
            clean_text: cleanText || text,
          });
        } else {
          // Direct message
          messages.push({
            from: msg.from,
            id: msg.id,
            timestamp: msg.timestamp,
            text: msg.text,
            type: msg.type,
            name: senderName,
            is_group: false,
            is_mention: false,
            clean_text: msg.text?.body,
          });
        }
      }
    }
  }

  return { messages };
}

/**
 * Format an answer response for WhatsApp.
 * In groups, prefix with sender's name so the reply is clearly addressed.
 */
export function formatAnswerForWhatsApp(
  answer: string,
  _confidence: string,
  isDuplicate: boolean,
  opts: { isGroup?: boolean; senderName?: string } = {}
): string {
  const { isGroup, senderName } = opts;

  let prefix = '';
  let suffix = '';

  // In groups, address the person who asked
  if (isGroup && senderName) {
    prefix = `@${senderName}\n\n`;
  }

  if (isDuplicate) {
    suffix = '\n\n_This was asked before — check earlier in the chat for more context._';
  }

  return prefix + answer + suffix;
}

/**
 * Typing indicator — marks the message as read so the sender sees the bot is working.
 */
export async function sendTypingIndicator(_toPhone: string, messageId: string): Promise<void> {
  await markAsRead(messageId).catch(() => {}); // non-critical
}
