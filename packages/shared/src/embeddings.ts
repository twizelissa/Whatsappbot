import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import getEnv from './config';

let _openai: OpenAI | null = null;
let _geminiClient: GoogleGenerativeAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    const env = getEnv();
    _openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _openai;
}

function getGeminiClient(): GoogleGenerativeAI {
  if (!_geminiClient) {
    const env = getEnv();
    if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');
    _geminiClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }
  return _geminiClient;
}

/**
 * Generate embeddings for one or more text strings.
 * Returns an array of embedding vectors.
 */
function getTargetDimensions(): number {
  const env = getEnv();
  return env.EMBEDDING_DIMENSIONS || 768;
}

export async function embed(texts: string[]): Promise<number[][]> {
  const env = getEnv();

  try {
    if (env.EMBEDDING_PROVIDER === 'gemini' && env.GEMINI_API_KEY) {
      return await embedGemini(texts);
    }

    if (env.EMBEDDING_PROVIDER === 'openai' && env.OPENAI_API_KEY) {
      return await embedOpenAI(texts);
    }

    if (env.GEMINI_API_KEY) {
      return await embedGemini(texts);
    }

    if (env.OPENAI_API_KEY) {
      return await embedOpenAI(texts);
    }
  } catch (err) {
    console.warn('⚠️ Embedding generation error, using zero-vector fallback:', err);
  }

  // Safe fallback: zero vector matching target dimension (default 768)
  const dim = getTargetDimensions();
  return texts.map(() => new Array(dim).fill(0));
}

export async function embedOne(text: string): Promise<number[]> {
  const results = await embed([text]);
  return results[0];
}

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  const env = getEnv();
  const openai = getOpenAI();

  // OpenAI max batch = 2048 strings; we chunk to be safe
  const BATCH_SIZE = 100;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await openai.embeddings.create({
      model: env.EMBEDDING_MODEL,
      input: batch,
      dimensions: getTargetDimensions(),
    });
    for (const item of res.data) {
      results.push(item.embedding);
    }
  }

  return results;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedGemini(texts: string[]): Promise<number[][]> {
  const env = getEnv();
  const rawModel = env.EMBEDDING_MODEL || 'gemini-embedding-001';
  const targetModel = (rawModel === 'text-embedding-004' || rawModel.includes('text-embedding'))
    ? 'gemini-embedding-001'
    : rawModel;
  const model = getGeminiClient().getGenerativeModel({ model: targetModel });
  const results: number[][] = [];
  const dim = getTargetDimensions();

  for (const text of texts) {
    let attempts = 0;
    let success = false;

    while (attempts < 3 && !success) {
      try {
        attempts++;
        const result = await model.embedContent(text);
        results.push(result.embedding.values);
        success = true;
      } catch (err: unknown) {
        const errStr = String(err);
        if (errStr.includes('404') || errStr.includes('not found')) {
          try {
            const fallbackModel = getGeminiClient().getGenerativeModel({ model: 'gemini-embedding-001' });
            const res = await fallbackModel.embedContent(text);
            results.push(res.embedding.values);
            success = true;
          } catch {
            results.push(new Array(dim).fill(0));
            success = true;
          }
        } else if (errStr.includes('429') || errStr.includes('Quota') || errStr.includes('RESOURCE_EXHAUSTED')) {
          if (attempts < 3) {
            await sleep(1000 * attempts);
          } else {
            results.push(new Array(dim).fill(0));
            success = true;
          }
        } else {
          if (attempts < 3) {
            await sleep(500 * attempts);
          } else {
            results.push(new Array(dim).fill(0));
            success = true;
          }
        }
      }
    }
  }

  return results;
}

async function embedLocal(texts: string[]): Promise<number[][]> {
  // Expects a local embedding server running at EMBEDDING_LOCAL_URL
  // e.g. using llama.cpp, Ollama, or sentence-transformers server
  const url = process.env.EMBEDDING_LOCAL_URL ?? 'http://localhost:8080/embedding';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) throw new Error(`Local embedding server error: ${res.status}`);
  const data = (await res.json()) as { embeddings: number[][] };
  return data.embeddings;
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Format embedding as Postgres vector string: '[0.1,0.2,...]'
 */
export function toVectorString(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Chunk text into overlapping segments for embedding.
 * Returns array of {text, startIdx, endIdx}.
 */
export function chunkText(
  text: string,
  chunkSize = 500,
  overlap = 50
): { text: string; startIdx: number; endIdx: number }[] {
  const words = text.split(/\s+/);
  const chunks: { text: string; startIdx: number; endIdx: number }[] = [];

  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const slice = words.slice(i, i + chunkSize);
    if (slice.length === 0) break;
    chunks.push({
      text: slice.join(' '),
      startIdx: i,
      endIdx: i + slice.length - 1,
    });
    if (i + chunkSize >= words.length) break;
  }

  return chunks;
}
