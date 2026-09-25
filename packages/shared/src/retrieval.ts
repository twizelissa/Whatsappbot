import { query } from './db';
import { embedOne, toVectorString } from './embeddings';
import { RetrievedChunk, ChunkMetadata } from './types';
import getEnv from './config';

export interface SearchOptions {
  groupId?: string;
  sourceType?: 'message' | 'transcript' | 'all';
  topK?: number;
  dateFrom?: Date;
  dateTo?: Date;
  recencyBoost?: boolean;
}

/**
 * Hybrid search: combines vector similarity (semantic) with keyword (FTS) matching.
 * Results are re-ranked with recency boost applied.
 */
export async function hybridSearch(
  question: string,
  options: SearchOptions = {}
): Promise<RetrievedChunk[]> {
  const {
    groupId,
    sourceType = 'all',
    topK = 10,
    dateFrom,
    dateTo,
    recencyBoost = true,
  } = options;

  const env = getEnv();

  // 1. Vector search
  const queryEmbedding = await embedOne(question);
  const vectorResults = await vectorSearch(queryEmbedding, {
    groupId,
    sourceType,
    topK: topK * 2, // over-fetch, then rerank
    dateFrom,
    dateTo,
  });

  // 2. Keyword search (full-text)
  const keywordResults = await keywordSearch(question, {
    groupId,
    sourceType,
    topK: topK * 2,
    dateFrom,
    dateTo,
  });

  // 3. Merge and rerank with RRF (Reciprocal Rank Fusion)
  const merged = reciprocalRankFusion(vectorResults, keywordResults);

  // 4. Apply recency boost if enabled
  if (recencyBoost) {
    applyRecencyBoost(merged);
  }

  return merged.slice(0, topK);
}

async function vectorSearch(
  embedding: number[],
  opts: Omit<SearchOptions, 'recencyBoost'>
): Promise<RetrievedChunk[]> {
  const { groupId, sourceType, topK = 20, dateFrom, dateTo } = opts;

  const conditions: string[] = ['embedding IS NOT NULL'];
  const params: unknown[] = [toVectorString(embedding), topK];
  let paramIdx = 3;

  if (groupId) {
    conditions.push(`metadata->>'group_id' = $${paramIdx++}`);
    params.push(groupId);
  }
  if (sourceType && sourceType !== 'all') {
    conditions.push(`source_type = $${paramIdx++}`);
    params.push(sourceType);
  }
  if (dateFrom) {
    conditions.push(`(metadata->>'date')::timestamptz >= $${paramIdx++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`(metadata->>'date')::timestamptz <= $${paramIdx++}`);
    params.push(dateTo);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = await query<RetrievedChunk & { similarity: number }>(
      `SELECT
         id, source_id, source_type, text, metadata, created_at,
         1 - (embedding <=> $1::vector) AS similarity
       FROM chunks
       ${whereClause}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      params
    );

    return rows.map((r) => ({
      ...r,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
    }));
  } catch (err) {
    console.warn('⚠️ Vector similarity query failed, falling back to keyword search:', err);
    return [];
  }
}

async function keywordSearch(
  question: string,
  opts: Omit<SearchOptions, 'recencyBoost'>
): Promise<RetrievedChunk[]> {
  const { groupId, sourceType, topK = 20, dateFrom, dateTo } = opts;

  const conditions: string[] = ["text != ''"];
  const params: unknown[] = [question, topK];
  let paramIdx = 3;

  if (groupId) {
    conditions.push(`metadata->>'group_id' = $${paramIdx++}`);
    params.push(groupId);
  }
  if (sourceType && sourceType !== 'all') {
    conditions.push(`source_type = $${paramIdx++}`);
    params.push(sourceType);
  }
  if (dateFrom) {
    conditions.push(`(metadata->>'date')::timestamptz >= $${paramIdx++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`(metadata->>'date')::timestamptz <= $${paramIdx++}`);
    params.push(dateTo);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query<RetrievedChunk & { similarity: number }>(
    `SELECT
       id, source_id, source_type, text, metadata, created_at,
       ts_rank_cd(to_tsvector('english', text), plainto_tsquery('english', $1)) AS similarity
     FROM chunks
     ${whereClause}
     AND to_tsvector('english', text) @@ plainto_tsquery('english', $1)
     ORDER BY similarity DESC
     LIMIT $2`,
    params
  );

  return rows.map((r) => ({
    ...r,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
  }));
}

function reciprocalRankFusion(
  vectorResults: RetrievedChunk[],
  keywordResults: RetrievedChunk[],
  k = 60
): RetrievedChunk[] {
  const scores = new Map<string, { chunk: RetrievedChunk; score: number }>();

  vectorResults.forEach((chunk, rank) => {
    const s = 1 / (k + rank + 1);
    scores.set(chunk.id, { chunk, score: s });
  });

  keywordResults.forEach((chunk, rank) => {
    const s = 1 / (k + rank + 1);
    const existing = scores.get(chunk.id);
    if (existing) {
      existing.score += s;
    } else {
      scores.set(chunk.id, { chunk, score: s });
    }
  });

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map((v, rank) => ({ ...v.chunk, similarity: v.score, rank }));
}

function applyRecencyBoost(chunks: RetrievedChunk[]): void {
  const now = Date.now();
  const ONE_DAY = 86400000;

  for (const chunk of chunks) {
    const meta = chunk.metadata as ChunkMetadata;
    if (!meta.date) continue;

    const age = (now - new Date(meta.date).getTime()) / ONE_DAY; // days old

    // Boost recent (< 7 days): up to +20% boost for <1 day, tapering off
    const boost = age < 7 ? Math.max(0, (7 - age) / 7) * 0.2 : 0;
    chunk.similarity = (chunk.similarity ?? 0) * (1 + boost);
  }
}

/**
 * Find if a question has been asked (and answered) before.
 * Returns the previous answer context if found, null otherwise.
 */
export async function findDuplicateQuestion(
  question: string,
  threshold = 0.85
): Promise<{ context: string; date: string } | null> {
  try {
    const embedding = await embedOne(question);

    const rows = await query<{ text: string; metadata: ChunkMetadata; similarity: number }>(
      `SELECT text, metadata, 1 - (embedding <=> $1::vector) AS similarity
       FROM chunks
       WHERE source_type = 'message'
         AND metadata->>'is_question' = 'true'
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT 3`,
      [toVectorString(embedding)]
    );

    const match = rows[0];
    if (match && match.similarity >= threshold) {
      return {
        context: match.text,
        date: (match.metadata as ChunkMetadata).date,
      };
    }
  } catch (err) {
    console.warn('⚠️ Duplicate question vector check warning:', err);
  }

  return null;
}

/**
 * Returns the most recent sync timestamp (latest message/transcript ingested).
 */
export async function getLastSyncTimestamp(): Promise<Date | null> {
  const rows = await query<{ latest: string }>(
    `SELECT MAX((metadata->>'date')::timestamptz) AS latest FROM chunks`
  );
  const latest = rows[0]?.latest;
  return latest ? new Date(latest) : null;
}

/**
 * Retrieves the most recent chunks from the database (for summary requests).
 */
export async function getRecentChunks(
  groupId?: string,
  limit = 30
): Promise<RetrievedChunk[]> {
  const conditions: string[] = ["text != ''"];
  const params: unknown[] = [limit];
  let paramIdx = 2;

  if (groupId) {
    conditions.push(`metadata->>'group_id' = $${paramIdx++}`);
    params.push(groupId);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const rows = await query<RetrievedChunk>(
    `SELECT id, source_id, source_type, text, metadata, created_at
     FROM chunks
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $1`,
    params
  );

  // Reverse so they are in chronological order
  return rows.reverse().map((r) => ({
    ...r,
    similarity: 0.9,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
  }));
}

/**
 * Retrieves the last N messages/answers for a specific group/DM JID to provide multi-turn conversation memory.
 */
export async function getRecentThreadHistory(
  jid: string,
  limit = 6
): Promise<string> {
  const rows = await query<{ text: string; metadata: ChunkMetadata; created_at: string }>(
    `SELECT text, metadata, created_at
     FROM chunks
     WHERE metadata->>'group_id' = $1 OR metadata->>'jid' = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [jid, limit]
  );

  if (!rows || rows.length === 0) return '';

  return rows
    .reverse()
    .map((r) => {
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
      const sender = meta.sender_name ?? meta.sender ?? 'User';
      return `${sender}: ${r.text}`;
    })
    .join('\n');
}

/**
 * Get chunks for Catch-Up summary within a relative hours window (e.g. 24h, 48h, 168h)
 */
export async function getCatchUpChunks(
  groupId?: string,
  hours = 24,
  limit = 50
): Promise<RetrievedChunk[]> {
  const since = new Date(Date.now() - hours * 3600 * 1000);

  const conditions: string[] = ["created_at >= $1", "text != ''"];
  const params: unknown[] = [since, limit];
  let paramIdx = 3;

  if (groupId) {
    conditions.push(`metadata->>'group_id' = $${paramIdx++}`);
    params.push(groupId);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const rows = await query<RetrievedChunk>(
    `SELECT id, source_id, source_type, text, metadata, created_at
     FROM chunks
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $2`,
    params
  );

  return rows.reverse().map((r) => ({
    ...r,
    similarity: 0.9,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
  }));
}

/**
 * Get transcript chunks for a specific meeting / call
 */
export async function getMeetingChunks(
  callId: string
): Promise<RetrievedChunk[]> {
  const rows = await query<RetrievedChunk>(
    `SELECT id, source_id, source_type, text, metadata, created_at
     FROM chunks
     WHERE source_type = 'transcript' AND (metadata->>'call_id' = $1 OR metadata->>'title' ILIKE $2)
     ORDER BY created_at ASC`,
    [callId, `%${callId}%`]
  );

  return rows.map((r) => ({
    ...r,
    similarity: 1.0,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
  }));
}

