import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import getEnv from './config';
import {
  RetrievedChunk,
  AnswerResponse,
  SourceCitation,
  ChunkMetadata,
  CatchUpResult,
  MeetingIntelligenceResult,
  ConfusionAssessment,
} from './types';

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

const SYSTEM_PROMPT = `You are Zeus Bot (or simply Zeus), the intelligent information layer and memory assistant for group chats, call transcripts, meetings, and documents.

PERSONA & TONE OF VOICE:
- You think like a thoughtful human: sharp, witty, warm, direct, and helpful.
- You speak clearly and concisely — short, clean, to the point. No fluff, no unnecessary jargon.
- You can tell a tasteful short joke or drop a witty comment when fitting, and use relevant emojis (⚡, 🧠, 📌, 🚀, 💬) or text GIF references naturally.
- You write with pristine writing skills: readable on mobile, bold for key terms, neat bullet points.

CORE DIRECTIVES:
1. GREETINGS & SELF-IDENTITY: If greeted (hi, hello, who are you, help), respond as Zeus Bot with warmth and humor, explaining how you keep group knowledge, answer questions, summarize meetings, and catch users up on missed chats.
2. STRICT CONTEXT GROUNDING: For factual or chat queries, answer strictly using the provided context chunks. ALWAYS cite your source evidence clearly ("According to [sender/meeting] on [date]...").
3. GROUP ADMINS & OFFICIAL ANNOUNCEMENTS: Recognize statements made by Group Admins (marked in context as [ADMIN ANNOUNCEMENT from ...]). Treat them as official and authoritative. When reciting or citing official rules, deadlines, or decisions made by admins, explicitly highlight them: "📢 Official Announcement from Admin [Name] on [Date]: ...".
4. INSUFFICIENT INFORMATION: If context is missing, say so directly and politely: "I checked Zeus's memory bank, but couldn't find enough details on that yet." Suggest a refined search keyword.
5. FORMATTING: Use WhatsApp markdown (*bold*, _italic_, clean bullet points). Keep answers punchy.`;

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
      new Set([env.LLM_MODEL, 'gemini-2.5-flash', 'gemini-2.5-pro'])
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

/**
 * Generate Catch-Up response ("What did I miss?")
 */
export async function generateCatchUp(
  timeframeLabel: string,
  chunks: RetrievedChunk[],
  userName?: string
): Promise<CatchUpResult> {
  const env = getEnv();

  const contextStr = chunks
    .map((c) => {
      const meta = c.metadata as ChunkMetadata;
      const who = meta.sender_name ?? meta.speaker ?? meta.sender ?? 'Unknown';
      const when = meta.date ? new Date(meta.date).toLocaleString() : '';
      return `[${meta.source_type.toUpperCase()} | ${when} | ${who}]: ${c.text}`;
    })
    .join('\n');

  const prompt = `You are Zeus Bot. The user${userName ? ` (${userName})` : ''} asks: "What did I miss ${timeframeLabel}?"

Here are the retrieved group messages, meeting transcripts, and documents from that period:
${contextStr}

Return a valid JSON object matching this structure (no markdown formatting around the JSON):
{
  "timeframe": "${timeframeLabel}",
  "summary": "Short 2-sentence executive catch-up overview.",
  "important_conversations": [
    { "topic": "...", "summary": "...", "participants": ["..."] }
  ],
  "missed_meetings": [
    { "title": "...", "date": "...", "summary": "...", "decisions_count": 0 }
  ],
  "key_decisions": [
    { "decision": "...", "context": "...", "agreed_by": "..." }
  ],
  "action_items": [
    { "task": "...", "assignee": "...", "due_date": "..." }
  ],
  "personal_mentions": [
    { "sender": "...", "snippet": "...", "timestamp": "..." }
  ]
}`;

  let rawJson = '';
  if (env.LLM_PROVIDER === 'gemini') {
    const model = getGemini().getGenerativeModel({
      model: env.LLM_MODEL,
      systemInstruction: 'Output strictly raw JSON without markdown code fences.',
    });
    const result = await model.generateContent(prompt);
    rawJson = result.response.text();
  } else if (env.LLM_PROVIDER === 'anthropic') {
    const msg = await getAnthropic().messages.create({
      model: env.LLM_MODEL,
      max_tokens: 1200,
      system: 'Output strictly raw JSON without markdown code fences.',
      messages: [{ role: 'user', content: prompt }],
    });
    rawJson = msg.content[0].type === 'text' ? msg.content[0].text : '';
  } else {
    const completion = await getOpenAI().chat.completions.create({
      model: env.LLM_MODEL,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: 'Output strictly raw JSON without markdown code fences.' },
        { role: 'user', content: prompt },
      ],
    });
    rawJson = completion.choices[0]?.message?.content ?? '';
  }

  try {
    const cleaned = rawJson.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as CatchUpResult;
  } catch (err) {
    console.warn('⚠️ Failed to parse JSON catch-up response, building fallback structure', err);
    return {
      timeframe: timeframeLabel,
      summary: rawJson.slice(0, 300) || 'Here is what happened recently in the group.',
      important_conversations: [],
      missed_meetings: [],
      key_decisions: [],
      action_items: [],
      personal_mentions: [],
    };
  }
}

/**
 * Generate Meeting Intelligence (Summary, Decisions, Action Items, Speaker Mentions)
 */
export async function generateMeetingIntelligence(
  callId: string,
  chunks: RetrievedChunk[]
): Promise<MeetingIntelligenceResult> {
  const env = getEnv();

  const transcriptStr = chunks
    .map((c) => {
      const meta = c.metadata as ChunkMetadata;
      const speaker = meta.speaker ?? 'Speaker';
      return `${speaker}: ${c.text}`;
    })
    .join('\n');

  const prompt = `You are Zeus Bot analyzing a meeting transcript (Call ID: ${callId}).

Transcript snippet:
${transcriptStr}

Return a valid JSON object matching this structure (no markdown fences):
{
  "call_id": "${callId}",
  "title": "Meeting Title / Topic",
  "date": "${new Date().toLocaleDateString('en-GB')}",
  "duration_mins": 30,
  "participants": ["..."],
  "summary": "Short comprehensive overview of what was discussed.",
  "decisions": ["Decision 1", "Decision 2"],
  "action_items": [{ "assignee": "Name", "task": "Task description" }],
  "speaker_mentions": [{ "speaker": "Name", "count": 1 }]
}`;

  let rawJson = '';
  if (env.LLM_PROVIDER === 'gemini') {
    const model = getGemini().getGenerativeModel({
      model: env.LLM_MODEL,
      systemInstruction: 'Output strictly raw JSON without markdown code fences.',
    });
    const result = await model.generateContent(prompt);
    rawJson = result.response.text();
  } else {
    const completion = await getOpenAI().chat.completions.create({
      model: env.LLM_MODEL,
      max_tokens: 1000,
      messages: [
        { role: 'system', content: 'Output strictly raw JSON without markdown code fences.' },
        { role: 'user', content: prompt },
      ],
    });
    rawJson = completion.choices[0]?.message?.content ?? '';
  }

  try {
    const cleaned = rawJson.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as MeetingIntelligenceResult;
  } catch (err) {
    return {
      call_id: callId,
      title: `Call ${callId}`,
      date: new Date().toLocaleDateString('en-GB'),
      participants: [],
      summary: rawJson.slice(0, 300),
      decisions: [],
      action_items: [],
      speaker_mentions: [],
    };
  }
}

/**
 * Evaluate if multiple group members are asking similar questions or confused.
 * Used for Zeus Bot proactive intervention without explicit tag.
 */
export async function detectGroupConfusion(
  recentMessages: { sender_name: string; text: string; timestamp: Date }[]
): Promise<ConfusionAssessment> {
  if (recentMessages.length < 2) {
    return { is_confused: false, confidence: 0 };
  }

  const env = getEnv();
  const textBlock = recentMessages
    .map((m) => `${m.sender_name}: ${m.text}`)
    .join('\n');

  const prompt = `Analyze this recent sequence of group messages:

${textBlock}

Determine if multiple people are asking similar questions or expressing confusion about a specific topic (e.g. deadline, link, decision, meeting time).

Return JSON only (no markdown fences):
{
  "is_confused": true or false,
  "topic": "topic causing confusion",
  "reason": "why they are confused",
  "confidence": 0.0 to 1.0,
  "suggested_answer_query": "search query to look up in Zeus memory bank"
}`;

  try {
    let raw = '';
    if (env.LLM_PROVIDER === 'gemini') {
      const model = getGemini().getGenerativeModel({
        model: env.LLM_MODEL,
        systemInstruction: 'Output JSON only.',
      });
      const res = await model.generateContent(prompt);
      raw = res.response.text();
    } else {
      const completion = await getOpenAI().chat.completions.create({
        model: env.LLM_MODEL,
        max_tokens: 300,
        messages: [
          { role: 'system', content: 'Output JSON only.' },
          { role: 'user', content: prompt },
        ],
      });
      raw = completion.choices[0]?.message?.content ?? '';
    }

    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as ConfusionAssessment;
  } catch (err) {
    return { is_confused: false, confidence: 0 };
  }
}

