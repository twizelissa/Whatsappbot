"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestMessage = ingestMessage;
exports.ingestTranscript = ingestTranscript;
exports.reembedUnprocessedChunks = reembedUnprocessedChunks;
const db_1 = require("./db");
const embeddings_1 = require("./embeddings");
const uuid_1 = require("uuid");
// ── Message ingestion ──────────────────────────────────────────────────────────
async function ingestMessage(msg) {
    // 1. Store raw message
    const [{ id: messageId }] = await (0, db_1.query)(`INSERT INTO messages (id, sender, sender_name, timestamp, text, source, media_url, media_type, reply_to, group_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`, [
        (0, uuid_1.v4)(),
        msg.sender,
        msg.sender_name,
        msg.timestamp,
        msg.text,
        msg.source,
        msg.media_url,
        msg.media_type,
        msg.reply_to,
        msg.group_id,
        JSON.stringify(msg.metadata),
    ]);
    // 2. Embed if there's text content
    if (msg.text && msg.text.trim().length > 0) {
        try {
            const text = msg.text.trim();
            // For short messages, don't chunk — embed whole
            const chunks = text.split(/\s+/).length > 100
                ? (0, embeddings_1.chunkText)(text, 300, 30)
                : [{ text, startIdx: 0, endIdx: text.length }];
            for (const chunk of chunks) {
                const embedding = await (0, embeddings_1.embedOne)(chunk.text);
                const metadata = {
                    date: msg.timestamp.toISOString(),
                    sender: msg.sender,
                    sender_name: msg.sender_name,
                    source_type: 'message',
                    group_id: msg.group_id,
                };
                await (0, db_1.query)(`INSERT INTO chunks (id, source_id, source_type, text, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5::vector, $6)`, [
                    (0, uuid_1.v4)(),
                    messageId,
                    'message',
                    chunk.text,
                    (0, embeddings_1.toVectorString)(embedding),
                    JSON.stringify(metadata),
                ]);
            }
        }
        catch (err) {
            console.error('⚠️ Could not generate embedding for message:', err);
        }
    }
    return messageId;
}
// ── Transcript ingestion ───────────────────────────────────────────────────────
async function ingestTranscript(transcript, callId) {
    for (const line of transcript) {
        const [{ id: transcriptId }] = await (0, db_1.query)(`INSERT INTO transcripts (id, call_id, timestamp, speaker, text, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`, [
            (0, uuid_1.v4)(),
            callId,
            line.timestamp,
            line.speaker,
            line.text,
            JSON.stringify(line.metadata),
        ]);
        if (line.text.trim().length === 0)
            continue;
        const embedding = await (0, embeddings_1.embedOne)(line.text);
        const metadata = {
            date: new Date().toISOString(),
            speaker: line.speaker ?? undefined,
            source_type: 'transcript',
            call_id: callId,
        };
        await (0, db_1.query)(`INSERT INTO chunks (id, source_id, source_type, text, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::vector, $6)`, [
            (0, uuid_1.v4)(),
            transcriptId,
            'transcript',
            line.text,
            (0, embeddings_1.toVectorString)(embedding),
            JSON.stringify(metadata),
        ]);
    }
}
// ── Bulk re-embed (for migration/repair) ──────────────────────────────────────
async function reembedUnprocessedChunks(batchSize = 50) {
    const chunks = await (0, db_1.query)(`SELECT id, text FROM chunks WHERE embedding IS NULL LIMIT $1`, [batchSize]);
    let count = 0;
    for (const chunk of chunks) {
        const embedding = await (0, embeddings_1.embedOne)(chunk.text);
        await (0, db_1.query)(`UPDATE chunks SET embedding = $1::vector WHERE id = $2`, [(0, embeddings_1.toVectorString)(embedding), chunk.id]);
        count++;
    }
    return count;
}
//# sourceMappingURL=ingest.js.map