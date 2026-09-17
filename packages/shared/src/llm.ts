import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import getEnv from './config';
import { RetrievedChunk, AnswerResponse, SourceCitation, ChunkMetadata } from './types';

let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;

function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const env = getEnv();
    _anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

function getOpenAI(): OpenAI {
  if (!_openai) {
    const env = getEnv();
    _openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _openai;
}

const SYSTEM_PROMPT = `You are UniPods Bot, an intelligent assistant for a WhatsApp group. 
You have access to the group's chat history and call transcripts, and your job is to answer questions accurately based ONLY on the provided context.

Rules:
1. ONLY answer based on the provided context chunks. Never invent or guess information.
2. ALWAYS cite your sources with the format: "According to [sender/speaker] on [date]..."
3. If the context is insufficient, stale, or you're not confident, say so explicitly: "I don't have enough information about this yet."
4. If a question was asked before, mention this: "This was discussed before on [date]."
5. Be concise and direct. Group chat users want quick answers.
6. When citing calls, say "In the call on [date]..."
7. Format your response for WhatsApp (no markdown headers, use emoji sparingly, keep it readable on mobile).

Your tone: helpful, direct, professional but friendly.`;

export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[],
  options: {
    isDuplicateQuestion?: boolean;
    duplicateContext?: string;
    freshnessMins?: number;
    userName?: string;
  } = {}
): Promise<AnswerResponse> {
  const env = getEnv();

  const { isDuplicateQuestion = false, duplicateContext, freshnessMins, userName } = options;

  // Confidence assessment
  const topSimilarity = chunks[0]?.similarity ?? 0;
  let confidence: AnswerResponse['confidence'];

  if (chunks.length === 0 || topSimilarity < 0.3) {
    confidence = 'insufficient';
  } else if (topSimilarity < env.LOW_CONFIDENCE_THRESHOLD) {
    confidence = 'low';
  } else if (topSimilarity < 0.7) {
    confidence = 'medium';
  } else {
    confidence = 'high';
  }

  // Freshness check
  if (freshnessMins && freshnessMins > 30) {
    if (confidence === 'high') confidence = 'medium';
    else if (confidence === 'medium') confidence = 'low';
  }

  // Build context string
  const contextStr = chunks
    .map((c, i) => {
      const meta = c.metadata as ChunkMetadata;
      const who = meta.sender_name ?? meta.speaker ?? meta.sender ?? 'Unknown';
      const when = meta.date ? new Date(meta.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Unknown date';
      const src = meta.source_type === 'transcript' ? `[CALL TRANSCRIPT - ${when}]` : `[MESSAGE from ${who} on ${when}]`;
      return `--- Context ${i + 1} ${src} ---\n${c.text}`;
    })
    .join('\n\n');

  const duplicateNote = isDuplicateQuestion && duplicateContext
    ? `\n\nNote: This question appears to have been asked before. Previous context: ${duplicateContext}`
    : '';

  const userContext = userName ? `The person asking is: ${userName}. ` : '';

  const userPrompt = `${userContext}Question: ${question}

Context from group history:
${contextStr}${duplicateNote}

${confidence === 'insufficient' ? 'Note: Very little relevant context was found. Please indicate this in your answer.' : ''}
${confidence === 'low' ? 'Note: The context found is not very specific to this question. Be appropriately cautious.' : ''}
${freshnessMins && freshnessMins > 60 ? `Note: The last sync was ${Math.round(freshnessMins)} minutes ago; very recent messages may not be indexed yet.` : ''}

Please answer the question based on the context above.`;

  let answer: string;

  if (env.LLM_PROVIDER === 'anthropic') {
    const msg = await getAnthropic().messages.create({
      model: env.LLM_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    answer = msg.content[0].type === 'text' ? msg.content[0].text : '';
  } else {
    const completion = await getOpenAI().chat.completions.create({
      model: env.LLM_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    answer = completion.choices[0]?.message?.content ?? '';
  }

  // Build source citations
  const sources: SourceCitation[] = chunks.slice(0, 5).map((c) => {
    const meta = c.metadata as ChunkMetadata;
    return {
      date: meta.date ?? '',
      sender: meta.sender_name ?? meta.sender,
      source_type: c.source_type as 'message' | 'transcript',
      snippet: c.text.slice(0, 120) + (c.text.length > 120 ? '...' : ''),
      call_id: meta.call_id,
    };
  });

  return {
    answer,
    sources,
    confidence,
    is_duplicate_question: isDuplicateQuestion,
    duplicate_context: duplicateContext,
  };
}

/**
 * Generate a digest summary for a given time period.
 */
export async function generateDigest(
  chunks: RetrievedChunk[],
  period: { from: Date; to: Date }
): Promise<string> {
  const env = getEnv();

  const contextStr = chunks
    .map((c) => {
      const meta = c.metadata as ChunkMetadata;
      const who = meta.sender_name ?? meta.speaker ?? 'Unknown';
      const when = meta.date ? new Date(meta.date).toLocaleString() : '';
      return `[${when}] ${who}: ${c.text}`;
    })
    .join('\n');

  const fromStr = period.from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const toStr = period.to.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  const prompt = `Here are the messages and call transcripts from the UniPods group from ${fromStr} to ${toStr}:

${contextStr}

Please create a concise digest summary suitable for WhatsApp. Include:
1. 📋 Key topics discussed (bullet points)
2. ✅ Decisions made or action items
3. 📞 Summary of any calls
4. 🔔 Important announcements

Keep it brief and scannable. Format for WhatsApp (no markdown headers).`;

  if (env.LLM_PROVIDER === 'anthropic') {
    const msg = await getAnthropic().messages.create({
      model: env.LLM_MODEL,
      max_tokens: 1024,
      system: 'You are a helpful group chat digest creator. Be concise and scannable.',
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0].type === 'text' ? msg.content[0].text : '';
  } else {
    const completion = await getOpenAI().chat.completions.create({
      model: env.LLM_MODEL,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: 'You are a helpful group chat digest creator. Be concise and scannable.' },
        { role: 'user', content: prompt },
      ],
    });
    return completion.choices[0]?.message?.content ?? '';
  }
}

/**
 * Generate a call recap from transcript chunks.
 */
export async function generateCallRecap(
  chunks: RetrievedChunk[],
  callId: string
): Promise<string> {
  const env = getEnv();

  const transcriptText = chunks
    .map((c) => {
      const meta = c.metadata as ChunkMetadata;
      const speaker = meta.speaker ?? 'Speaker';
      const time = meta.date ? `[${new Date(meta.date).toLocaleTimeString()}]` : '';
      return `${time} ${speaker}: ${c.text}`;
    })
    .join('\n');

  const prompt = `Here is the transcript from a call (ID: ${callId}):

${transcriptText}

Please create a concise call recap for the WhatsApp group. Include:
1. 📞 Call summary (2-3 sentences)
2. 🔑 Key points discussed
3. ✅ Action items and decisions
4. 👤 Who said what (if speakers are identified)

Format for WhatsApp. Be brief.`;

  if (env.LLM_PROVIDER === 'anthropic') {
    const msg = await getAnthropic().messages.create({
      model: env.LLM_MODEL,
      max_tokens: 800,
      system: 'You are creating a call recap for a WhatsApp group. Be concise.',
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0].type === 'text' ? msg.content[0].text : '';
  } else {
    const completion = await getOpenAI().chat.completions.create({
      model: env.LLM_MODEL,
      max_tokens: 800,
      messages: [
        { role: 'system', content: 'You are creating a call recap for a WhatsApp group. Be concise.' },
        { role: 'user', content: prompt },
      ],
    });
    return completion.choices[0]?.message?.content ?? '';
  }
}
