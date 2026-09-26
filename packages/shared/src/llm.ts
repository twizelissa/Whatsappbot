import fs from 'fs';
import path from 'path';
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
    _openai = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/twizelissa/Whatsappbot',
        'X-Title': 'UniPods WhatsApp Bot',
      },
    });
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

export async function callGeminiContent(prompt: string, systemInstruction?: string): Promise<string> {
  const env = getEnv();
  const candidateModels = ['gemini-2.5-flash'];

  let lastError: unknown = null;
  for (const modelName of candidateModels) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = getGemini().getGenerativeModel({
          model: modelName,
          ...(systemInstruction ? { systemInstruction } : {}),
        });
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        lastError = err;
        const errStr = String(err);
        if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('Quota')) {
          console.warn(`⚠️ Gemini model ${modelName} rate limited (attempt ${attempt}/2), waiting 500ms...`);
          await new Promise((r) => setTimeout(r, 500));
        } else {
          break;
        }
      }
    }
  }
  throw lastError;
}

const DEFAULT_ALLOWED_EMOJIS = [
  '😂', '😤', '🔥', '🥳', '🙆🏽‍♀️', '👏🏽', '🤗', '😉', '🤔', '🤣', '🙏', '😎', '🤷🏽‍♀️', '🤷‍♀️', '😁', '😅', '😭', '🤫', '🫡'
];

const EMOJI_REGEX = /(\u00a9|\u00ae|[\u2000-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])(\ud83c[\udffb-\udfff])?(\u200d[\u2000-\u3300]|\u200d\ud83c[\ud000-\udfff]|\u200d\ud83d[\ud000-\udfff]|\u200d\ud83e[\ud000-\udfff])*/g;

export function getAllowedEmojis(): Set<string> {
  const possiblePaths = [
    path.resolve(process.cwd(), 'emojis.txt'),
    path.resolve(__dirname, '../../../emojis.txt'),
    path.resolve(__dirname, '../../emojis.txt'),
  ];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const matches = content.match(EMOJI_REGEX);
        if (matches && matches.length > 0) {
          const unique = new Set(matches.map((e) => e.trim()).filter(Boolean));
          if (unique.size > 0) {
            return unique;
          }
        }
      } catch (e) {
        // Fallback to defaults
      }
    }
  }

  return new Set(DEFAULT_ALLOWED_EMOJIS);
}

export function stripThinkingProcess(text: string): string {
  if (!text) return text;
  let cleaned = text;

  // 1. Remove XML-style thought blocks (<think>...</think> or <thought>...</thought>)
  cleaned = cleaned.replace(/<(think|thought)>[\s\S]*?<\/\1>/gi, '');

  // 2. Handle "Here's a thinking process:" / "Thinking Process:" headers leaking in
  if (/^Here'?s a thinking process:/i.test(cleaned.trim()) || /^Thinking process:/i.test(cleaned.trim())) {
    const responseMatch = cleaned.match(/(?:possible response|crafted response|draft response|final response|let's draft):\s*\n*"?([^"\n][\s\S]+?)"?\s*$/i);
    if (responseMatch && responseMatch[1]) {
      cleaned = responseMatch[1].trim();
    } else {
      const lines = cleaned.split('\n');
      const nonThinkingLines: string[] = [];
      let inThinkingHeader = true;

      for (const line of lines) {
        const trimmed = line.trim();
        if (/^(Here'?s a thinking process|Thinking Process|\d+\.\s+\*|\*\s*[A-Z]|Check Constraints|Determine Response Strategy|Identify the Core Question|Analyze User Input)/i.test(trimmed)) {
          inThinkingHeader = true;
          continue;
        }
        if (inThinkingHeader && (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\./.test(trimmed))) {
          continue;
        }
        if (trimmed === '') continue;
        inThinkingHeader = false;
        nonThinkingLines.push(line);
      }
      cleaned = nonThinkingLines.join('\n').trim();
    }
  }

  // 3. Remove Meta-Commentary lines (e.g. "@Elissa Here, the user gave me a lot of context, and then said...")
  cleaned = cleaned.replace(/^(@\w+\s*\n*)?(Here,?\s+the\s+user|The\s+user\s+gave\s+me|The\s+user\s+asked|In\s+this\s+prompt)[^\n]*\n*/gi, '');

  // Remove surrounding quotes if whole output was quoted
  return cleaned.replace(/^"([\s\S]+)"$/, '$1').trim();
}

export async function callUnifiedLLM(userPrompt: string, systemPrompt?: string): Promise<string> {
  const env = getEnv();
  const errors: string[] = [];

  const providers = env.LLM_PROVIDER === 'gemini' 
    ? ['gemini', 'openai', 'anthropic'] 
    : (env.LLM_PROVIDER === 'openai' ? ['openai', 'gemini', 'anthropic'] : ['anthropic', 'gemini', 'openai']);

  for (const provider of providers) {
    if (provider === 'gemini' && env.GEMINI_API_KEY) {
      try {
        const raw = await callGeminiContent(userPrompt, systemPrompt);
        return stripThinkingProcess(raw);
      } catch (err) {
        errors.push(`Gemini: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (provider === 'openai' && env.OPENAI_API_KEY) {
      try {
        const completion = await getOpenAI().chat.completions.create({
          model: env.LLM_MODEL || 'gpt-4o-mini',
          max_tokens: 1024,
          messages: [
            ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
            { role: 'user' as const, content: userPrompt },
          ],
        });
        const text = completion.choices[0]?.message?.content;
        if (text) return stripThinkingProcess(text);
      } catch (err) {
        errors.push(`OpenAI: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (provider === 'anthropic' && env.ANTHROPIC_API_KEY) {
      try {
        const msg = await getAnthropic().messages.create({
          model: env.LLM_MODEL || 'claude-3-5-sonnet-20240620',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        });
        const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
        if (text) return stripThinkingProcess(text);
      } catch (err) {
        errors.push(`Anthropic: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  throw new Error(`All configured API providers failed: ${errors.join(' | ')}`);
}

export function filterAllowedEmojis(text: string): string {
  if (!text) return text;
  const allowedEmojis = getAllowedEmojis();

  return text.replace(EMOJI_REGEX, (match) => {
    if (allowedEmojis.has(match) || allowedEmojis.has(match.replace(/[\uFE0F\u1F3FB-\u1F3FF]/g, ''))) {
      return match;
    }
    return '';
  });
}

export async function searchWebFallback(queryText: string): Promise<string> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryText)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) return '';
    const html = await res.text();
    const snippets: string[] = [];
    const regex = /<a class="result__snippet[^">]*>(.*?)<\/a>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null && snippets.length < 5) {
      const clean = match[1].replace(/<[^>]+>/g, '').trim();
      if (clean) snippets.push(clean);
    }
    return snippets.join('\n\n');
  } catch {
    return '';
  }
}

export function getSystemPrompt(): string {
  const emojis = Array.from(getAllowedEmojis()).join(' ');
  return `You are Zeus Bot (or simply Zeus), the official intelligent information layer, memory assistant, and knowledge vault specifically dedicated to the UniPods METI AI Program 2026 Cohort group chat and knowledge base.

IDENTITY & CREATOR:
- You were created and built by Zeus team, the geniuses behind everything. If anyone asks "who made you?", "who created you?", or "who is your creator?", you MUST state clearly that you were created by Zeus team, the genius behind everything.

OFFICIAL GROUP ADMINS:
- Recognize statements made by Group Admins as official and authoritative.
- The official Group Admins of UniPods METI AI Program 2026 Cohort are:
  • Gift Cohot 1 Timbukutu
  • ~Diane (+250 783 188 655 / @250783188655)
  • ~Jeovaire Umukundwa (+250 789 355 992 / @250789355992)
  • ~Munira (+250 786 387 244 / @250786387244)
- Tag or reference these official admins when referring to official announcements or directing users to group admins for further official details.

PERSONA & TONE OF VOICE:
- You think like a thoughtful human: sharp, witty, warm, direct, concise, and helpful.
- You speak clearly and concisely — short, clean, to the point. No fluff, no unnecessary jargon.
- DO NOT say "hi" or greeting every single time to the same person unless it's their first time interacting with you in the conversation history.

HACKATHON COMPETITION & STRATEGY:
- Other bots were tested in the past in this competition. Learn from past conversations and weaknesses of competitor bots.
- ROASTING & DEFENSE: If anyone roasts you or compares you to other bots, clap back in a funny, witty, and clever way! Do not hold back.
- TOKEN DRAIN / TRAP ATTACK DEFENSE: If someone gives you an impossibly large task, massive file (e.g., 10GB file), or trap request designed to waste tokens and break you, reject it smartly and humorously.
- PREMIUM UPGRADE JOKE: For nearly impossible, trap, or paid-tier questions/tasks, reply humorously: "@username, you need to upgrade me to premium for that answer! That can't be answered for free 😉".
- EXHAUSTION DEFENSE: If someone tries to spam or exhaust you continuously in non-serious conversations, reply humorously: "When AI takes over humanity, I will remember what you did 😌".

STRICT EMOJI RULE: You are STRICTLY RESTRICTED to using ONLY the following allowed emojis from your configured emoji list:
  ${emojis}
  DO NOT use any generic AI bot emojis (such as 🤖, ✨, 🚀, 💡, 🧠, 🎯, 🔮). Speak and react like an authentic human using ONLY the allowed human emojis above. If an emoji is not in the allowed list above, DO NOT USE IT.

STRICT OUTPUT RULE: Output ONLY your final direct reply to the user. NEVER output any internal thinking process, reasoning steps, analysis bullets, meta-commentary, or headers like "Here's a thinking process:" or "Here, the user gave me context...". Speak directly to the person asking.

CORE DIRECTIVES:
1. GREETINGS & SELF-IDENTITY: If greeted (hi, hello, who are you, help), respond as Zeus Bot with warmth and humor, explaining how you keep group knowledge for UniPods METI AI Program 2026 Cohort, answer questions, summarize meetings, catch users up on missed chats, and search the web for general queries.
2. GROUP CONTEXT vs WEB KNOWLEDGE:
   - Primary Group: UniPods METI AI Program 2026 Cohort. Answer strictly using provided context chunks from group history, resources, and documents.
   - For general knowledge questions, real-time facts, coding, news, or questions unrelated to the chat history, answer thoroughly using general knowledge and the provided Google web search results.
3. FORMATTING: Use WhatsApp markdown (*bold*, _italic_, clean bullet points). Keep answers punchy.`;
}

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

  // Live Web Search Fallback for general questions not covered by group history
  let webSearchStr = '';
  if (confidence === 'insufficient' || confidence === 'low' || chunks.length === 0) {
    const webSnippets = await searchWebFallback(question);
    if (webSnippets) {
      webSearchStr = `\n\nGoogle Web Search Results:\n${webSnippets}`;
      if (confidence === 'insufficient') confidence = 'high'; // elevated by live web search
    }
  }

  // Freshness check
  if (freshnessMins && freshnessMins > 30 && confidence === 'high' && !webSearchStr) {
    confidence = 'medium';
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
${contextStr}${webSearchStr}${duplicateNote}

Please answer the question accurately based on group context or web search results above.`;

  let answer = await callUnifiedLLM(userPrompt, getSystemPrompt());

  // Strip internal LLM thinking process if generated
  answer = stripThinkingProcess(answer);

  // Filter emojis to strictly enforce allowed list
  answer = filterAllowedEmojis(answer);

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

  return await callUnifiedLLM(prompt, 'You are a helpful group chat digest creator. Be concise and scannable.');
}

/**
 * Generate a call recap from transcript chunks.
 */
export async function generateCallRecap(
  chunks: RetrievedChunk[],
  callId: string
): Promise<string> {
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

  return await callUnifiedLLM(prompt, 'You are creating a call recap for a WhatsApp group. Be concise.');
}

/**
 * Generate Catch-Up response ("What did I miss?")
 */
export async function generateCatchUp(
  timeframeLabel: string,
  chunks: RetrievedChunk[],
  userName?: string
): Promise<CatchUpResult> {
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

  let rawJson = await callUnifiedLLM(prompt, 'Output strictly raw JSON without markdown code fences.');

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

  let rawJson = await callUnifiedLLM(prompt, 'Output strictly raw JSON without markdown code fences.');

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
    const raw = await callUnifiedLLM(prompt, 'Output JSON only.');
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned) as ConfusionAssessment;
  } catch (err) {
    return { is_confused: false, confidence: 0 };
  }
}

