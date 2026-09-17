import getEnv from '@unipods/shared/src/config';
import pino from 'pino';

const logger = pino({ level: 'info' });
const WHATSAPP_API_BASE = 'https://graph.facebook.com/v20.0';

export interface WhatsAppMessage {
  from: string;           // sender's phone number
  id: string;             // message ID
  timestamp: string;
  text?: { body: string };
  type: string;
  name?: string;
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
        messages?: WhatsAppMessage[];
        statuses?: unknown[];
      };
      field: string;
    }>;
  }>;
}

/**
 * Send a text reply via WhatsApp Cloud API.
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
    text: { body: text.slice(0, 4096) }, // WA max is 4096 chars
  };

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

  logger.info({ toPhone, textLen: text.length }, '✅ WhatsApp reply sent');
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
 * Parse the webhook payload and extract messages.
 */
export function parseWebhookPayload(body: unknown): {
  messages: (WhatsAppMessage & { senderName?: string })[];
} {
  const payload = body as WhatsAppWebhookPayload;

  if (payload.object !== 'whatsapp_business_account') {
    return { messages: [] };
  }

  const messages: (WhatsAppMessage & { senderName?: string })[] = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;

      const { messages: msgs, contacts } = change.value;
      if (!msgs) continue;

      for (const msg of msgs) {
        const contact = contacts?.find((c) => c.wa_id === msg.from);
        messages.push({ ...msg, senderName: contact?.profile.name });
      }
    }
  }

  return { messages };
}

/**
 * Format an answer response for WhatsApp.
 * Adds confidence indicator and source citations.
 */
export function formatAnswerForWhatsApp(
  answer: string,
  confidence: string,
  isDuplicate: boolean
): string {
  let prefix = '';
  let suffix = '';

  if (confidence === 'insufficient') {
    prefix = '❓ ';
  } else if (confidence === 'low') {
    prefix = '⚠️ *Low confidence* — I found some related info but may not be complete:\n\n';
  }

  if (isDuplicate) {
    suffix = '\n\n📌 _Note: This question was asked before — see above for when it was last discussed._';
  }

  return prefix + answer + suffix;
}

/**
 * Typing indicator (sending status)
 */
export async function sendTypingIndicator(toPhone: string, messageId: string): Promise<void> {
  const env = getEnv();

  // Mark as read first (this triggers "read" receipt, implying we're processing)
  await markAsRead(messageId).catch(() => {}); // non-critical
}
