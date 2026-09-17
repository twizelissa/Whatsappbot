import OpenAI from 'openai';
import getEnv from './config';

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) {
    const env = getEnv();
    _openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _openai;
}

/**
 * Generate embeddings for one or more text strings.
 * Returns an array of embedding vectors.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  const env = getEnv();

  if (env.EMBEDDING_PROVIDER === 'openai') {
    return embedOpenAI(texts);
  }

  // Fallback: local embedding via sentence-transformers HTTP endpoint
  return embedLocal(texts);
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
      dimensions: env.EMBEDDING_DIMENSIONS,
    });
    for (const item of res.data) {
      results.push(item.embedding);
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
