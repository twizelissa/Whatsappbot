"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hybridSearch = hybridSearch;
exports.findDuplicateQuestion = findDuplicateQuestion;
exports.getLastSyncTimestamp = getLastSyncTimestamp;
exports.getRecentChunks = getRecentChunks;
exports.getRecentThreadHistory = getRecentThreadHistory;
exports.getCatchUpChunks = getCatchUpChunks;
exports.getMeetingChunks = getMeetingChunks;
const db_1 = require("./db");
const embeddings_1 = require("./embeddings");
const config_1 = __importDefault(require("./config"));
/**
 * Hybrid search: combines vector similarity (semantic) with keyword (FTS) matching.
 * Results are re-ranked with recency boost applied.
 */
async function hybridSearch(question, options = {}) {
    const { groupId, sourceType = 'all', topK = 10, dateFrom, dateTo, recencyBoost = true, } = options;
    const env = (0, config_1.default)();
    // 1. Vector search
    const queryEmbedding = await (0, embeddings_1.embedOne)(question);
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
async function vectorSearch(embedding, opts) {
    const { groupId, sourceType, topK = 20, dateFrom, dateTo } = opts;
    const conditions = ['embedding IS NOT NULL'];
    const params = [(0, embeddings_1.toVectorString)(embedding), topK];
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
    const rows = await (0, db_1.query)(`SELECT
       id, source_id, source_type, text, metadata, created_at,
       1 - (embedding <=> $1::vector) AS similarity
     FROM chunks
     ${whereClause}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`, params);
    return rows.map((r) => ({
        ...r,
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
    }));
}
async function keywordSearch(question, opts) {
    const { groupId, sourceType, topK = 20, dateFrom, dateTo } = opts;
    const conditions = ["text != ''"];
    const params = [question, topK];
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
    const rows = await (0, db_1.query)(`SELECT
       id, source_id, source_type, text, metadata, created_at,
       ts_rank_cd(to_tsvector('english', text), plainto_tsquery('english', $1)) AS similarity
     FROM chunks
     ${whereClause}
     AND to_tsvector('english', text) @@ plainto_tsquery('english', $1)
     ORDER BY similarity DESC
     LIMIT $2`, params);
    return rows.map((r) => ({
        ...r,
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
    }));
}
function reciprocalRankFusion(vectorResults, keywordResults, k = 60) {
    const scores = new Map();
    vectorResults.forEach((chunk, rank) => {
        const s = 1 / (k + rank + 1);
        scores.set(chunk.id, { chunk, score: s });
    });
    keywordResults.forEach((chunk, rank) => {
        const s = 1 / (k + rank + 1);
        const existing = scores.get(chunk.id);
        if (existing) {
            existing.score += s;
        }
        else {
            scores.set(chunk.id, { chunk, score: s });
        }
    });
    return Array.from(scores.values())
        .sort((a, b) => b.score - a.score)
        .map((v, rank) => ({ ...v.chunk, similarity: v.score, rank }));
}
function applyRecencyBoost(chunks) {
    const now = Date.now();
    const ONE_DAY = 86400000;
    for (const chunk of chunks) {
        const meta = chunk.metadata;
        if (!meta.date)
            continue;
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
async function findDuplicateQuestion(question, threshold = 0.85) {
    const embedding = await (0, embeddings_1.embedOne)(question);
    const rows = await (0, db_1.query)(`SELECT text, metadata, 1 - (embedding <=> $1::vector) AS similarity
     FROM chunks
     WHERE source_type = 'message'
       AND metadata->>'is_question' = 'true'
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 3`, [(0, embeddings_1.toVectorString)(embedding)]);
    const match = rows[0];
    if (match && match.similarity >= threshold) {
        return {
            context: match.text,
            date: match.metadata.date,
        };
    }
    return null;
}
/**
 * Returns the most recent sync timestamp (latest message/transcript ingested).
 */
async function getLastSyncTimestamp() {
    const rows = await (0, db_1.query)(`SELECT MAX((metadata->>'date')::timestamptz) AS latest FROM chunks`);
    const latest = rows[0]?.latest;
    return latest ? new Date(latest) : null;
}
/**
 * Retrieves the most recent chunks from the database (for summary requests).
 */
async function getRecentChunks(groupId, limit = 30) {
    const conditions = ["text != ''"];
    const params = [limit];
    let paramIdx = 2;
    if (groupId) {
        conditions.push(`metadata->>'group_id' = $${paramIdx++}`);
        params.push(groupId);
    }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const rows = await (0, db_1.query)(`SELECT id, source_id, source_type, text, metadata, created_at
     FROM chunks
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $1`, params);
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
async function getRecentThreadHistory(jid, limit = 6) {
    const rows = await (0, db_1.query)(`SELECT text, metadata, created_at
     FROM chunks
     WHERE metadata->>'group_id' = $1 OR metadata->>'jid' = $1
     ORDER BY created_at DESC
     LIMIT $2`, [jid, limit]);
    if (!rows || rows.length === 0)
        return '';
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
async function getCatchUpChunks(groupId, hours = 24, limit = 50) {
    const since = new Date(Date.now() - hours * 3600 * 1000);
    const conditions = ["created_at >= $1", "text != ''"];
    const params = [since, limit];
    let paramIdx = 3;
    if (groupId) {
        conditions.push(`metadata->>'group_id' = $${paramIdx++}`);
        params.push(groupId);
    }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const rows = await (0, db_1.query)(`SELECT id, source_id, source_type, text, metadata, created_at
     FROM chunks
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $2`, params);
    return rows.reverse().map((r) => ({
        ...r,
        similarity: 0.9,
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
    }));
}
/**
 * Get transcript chunks for a specific meeting / call
 */
async function getMeetingChunks(callId) {
    const rows = await (0, db_1.query)(`SELECT id, source_id, source_type, text, metadata, created_at
     FROM chunks
     WHERE source_type = 'transcript' AND (metadata->>'call_id' = $1 OR metadata->>'title' ILIKE $2)
     ORDER BY created_at ASC`, [callId, `%${callId}%`]);
    return rows.map((r) => ({
        ...r,
        similarity: 1.0,
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
    }));
}
//# sourceMappingURL=retrieval.js.map