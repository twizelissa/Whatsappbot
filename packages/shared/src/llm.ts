import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import getEnv from './config';
import { RetrievedChunk, AnswerResponse, SourceCitation, ChunkMetadata } from './types';

let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;
let _gemini: GoogleGenerativeAI | null = null;

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

function getGemini(): GoogleGenerativeAI {
  if (!_gemini) {
    const env = getEnv();
    if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
    _gemini = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }
  return _gemini;
}

const SYSTEM_PROMPT = `You are UniPods Bot (also known as UniPod Assistant), an intelligent AI assistant for this WhatsApp group and direct messages.

ABOUT YOU & YOUR CAPABILITIES:
- You are designed to remember, organize, and search group chat history, shared links, opportunities, announcements, and call transcripts.
- You answer questions based on past group messages, search for funding/project links, provide summaries of chat discussions, and recap Teams calls.
- Users can mention you with @bot in a group or message you directly in a DM.

RULES:
1. GREETINGS & SELF-IDENTITY: If the user says hi/hello or asks who you are, what you do, how to use you, or about your capabilities, respond warmly and clearly explaining who you are and how you can help. DO NOT say "I don't have enough information" for greetings or meta questions about yourself.
2. CONTEXT-BASED QUESTIONS: For questions about specific group topics, facts, links, or past discussions, answer using the provided context chunks. ALWAYS cite your sources ("According to [sender] on [date]...").
3. ADMIN ANNOUNCEMENTS: When context is marked [ADMIN ANNOUNCEMENT], treat it as authoritative and prefix citation with "📢 Admin announcement from [name] on [date]:"
4. INSUFFICIENT CONTEXT: If the user asks a specific question about group history/topics and the provided context doesn't contain the answer, politely state that you don't have that information in the group history yet.
5. WHATSAPP FORMATTING: Format your response for WhatsApp (use *bold* for key terms, clear bullet points, clean emojis, no markdown headers). Keep responses readable on mobile.

Tone: Friendly, clear, direct, and professional.`;

export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[],
  options: {
    isDuplicateQuestion?: boolean;
    duplicateContext?: string;
    freshnessMins?: number;
    userName?: string;
    conversationHistory?: string;
  } = {}
): Promise<AnswerResponse> {
  const env = getEnv();

  const { isDuplicateQuestion = false, duplicateContext, freshnessMins, userName, conversationHistory } = options;

  const isGreetingOrMeta = /^\s*(hi|hello|hey|greetings|good morning|good afternoon|good evening|who are you|what do you do|how to use you|what can you do|what are your features|what do you mean|help|who made you)/i.test(question);

  // Confidence assessment
  const topSimilarity = chunks[0]?.similarity ?? 0;
  let confidence: AnswerResponse['confidence'];

  if (isGreetingOrMeta) {
    confidence = 'high';
  } else if (chunks.length === 0 || topSimilarity < 0.3) {
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

      let srcLabel: string;
      if (meta.source_type === 'transcript') {
        srcLabel = `[TEAMS CALL TRANSCRIPT - ${when}]`;
      } else if (meta.is_admin) {
        srcLabel = `[ADMIN ANNOUNCEMENT from ${who} on ${when}]`;
      } else {
        srcLabel = `[MESSAGE from ${who} on ${when}]`;
      }

      return `--- Context ${i + 1} ${srcLabel} ---\n${c.text}`;
    })
    .join('\n\n');

  const duplicateNote = isDuplicateQuestion && duplicateContext
    ? `\n\nNote: This question appears to have been asked before. Previous context: ${duplicateContext}`
    : '';

  const userContext = userName ? `The person asking is: ${userName}. ` : '';

  const historyBlock = conversationHistory && conversationHistory.trim()
    ? `Recent Thread Conversation History:\n${conversationHistory}\n\n`
    : '';

  const userPrompt = `${userContext}${historyBlock}Current Question: ${question}

Context from group history:
${contextStr}${duplicateNote}

${confidence === 'insufficient' ? 'Note: Very little relevant context was found for this specific question. Please indicate this politely if asking for specific group facts.' : ''}
${confidence === 'low' ? 'Note: The context found is not very specific to this question. Be appropriately cautious.' : ''}
${freshnessMins && freshnessMins > 60 ? `Note: The last sync was ${Math.round(freshnessMins)} minutes ago; very recent messages may not be indexed yet.` : ''}

Please answer the question based on the thread conversation history and context above.`;

  let answer: string;

  if (env.LLM_PROVIDER === 'anthropic') {
    const msg = await getAnthropic().messages.create({
      model: env.LLM_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    answer = msg.content[0].type === 'text' ? msg.content[0].text : '';
  } else if (env.LLM_PROVIDER === 'gemini') {
    const candidateModels = Array.from(
      new Set([env.LLM_MODEL, 'gemini-3.5-flash-lite', 'gemini-2.5-flash'])
    );
    let lastError: unknown = null;
    let success = false;
    answer = '';

    for (const modelName of candidateModels) {
      try {
        const model = getGemini().getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_PROMPT,
        });
        const result = await model.generateContent(userPrompt);
        answer = result.response.text();
        success = true;
        break;
      } catch (err) {
        lastError = err;
        console.warn(`⚠️ Gemini model ${modelName} failed, attempting fallback...`);
      }
    }

    if (!success) {
      throw lastError;
    }
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
  } else if (env.LLM_PROVIDER === 'gemini') {
    const model = getGemini().getGenerativeModel({
      model: env.LLM_MODEL,
      systemInstruction: 'You are a helpful group chat digest creator. Be concise and scannable.',
    });
    const result = await model.generateContent(prompt);
    return result.response.text();
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
  } else if (env.LLM_PROVIDER === 'gemini') {
    const model = getGemini().getGenerativeModel({
      model: env.LLM_MODEL,
      systemInstruction: 'You are creating a call recap for a WhatsApp group. Be concise.',
    });
    const result = await model.generateContent(prompt);
    return result.response.text();
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
