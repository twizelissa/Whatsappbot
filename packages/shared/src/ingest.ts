import { query } from './db';
import { embedOne, toVectorString, chunkText } from './embeddings';
import { Message, Transcript, Chunk, ChunkMetadata } from './types';
import { v4 as uuidv4 } from 'uuid';

// ── Message ingestion ──────────────────────────────────────────────────────────

export async function ingestMessage(msg: Omit<Message, 'id'>): Promise<string> {
  // 1. Store raw message
  const [{ id: messageId }] = await query<{ id: string }>(
    `INSERT INTO messages (id, sender, sender_name, timestamp, text, source, media_url, media_type, reply_to, group_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      uuidv4(),
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
    ]
  );

  // 2. Embed if there's text content
  if (msg.text && msg.text.trim().length > 0) {
    try {
      const text = msg.text.trim();
      // For short messages, don't chunk — embed whole
      const chunks =
        text.split(/\s+/).length > 100
          ? chunkText(text, 300, 30)
          : [{ text, startIdx: 0, endIdx: text.length }];

      for (const chunk of chunks) {
        const embedding = await embedOne(chunk.text);
        const metadata: ChunkMetadata = {
          date: msg.timestamp.toISOString(),
          sender: msg.sender,
          sender_name: msg.sender_name,
          source_type: 'message',
          group_id: msg.group_id,
        };

        await query(
          `INSERT INTO chunks (id, source_id, source_type, text, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5::vector, $6)`,
          [
            uuidv4(),
            messageId,
            'message',
            chunk.text,
            toVectorString(embedding),
            JSON.stringify(metadata),
          ]
        );
      }
    } catch (err) {
      console.error('⚠️ Could not generate embedding for message:', err);
    }
  }

  return messageId;
}

// ── Transcript ingestion ───────────────────────────────────────────────────────

export async function ingestTranscript(
  transcript: Omit<Transcript, 'id'>[],
  callId: string
): Promise<void> {
  for (const line of transcript) {
    const [{ id: transcriptId }] = await query<{ id: string }>(
      `INSERT INTO transcripts (id, call_id, timestamp, speaker, text, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        uuidv4(),
        callId,
        line.timestamp,
        line.speaker,
        line.text,
        JSON.stringify(line.metadata),
      ]
    );

    if (line.text.trim().length === 0) continue;

    const embedding = await embedOne(line.text);
    const metadata: ChunkMetadata = {
      date: new Date().toISOString(),
      speaker: line.speaker ?? undefined,
      source_type: 'transcript',
      call_id: callId,
    };

    await query(
      `INSERT INTO chunks (id, source_id, source_type, text, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::vector, $6)`,
      [
        uuidv4(),
        transcriptId,
        'transcript',
        line.text,
        toVectorString(embedding),
        JSON.stringify(metadata),
      ]
    );
  }
}

// ── Bulk re-embed (for migration/repair) ──────────────────────────────────────

export async function reembedUnprocessedChunks(batchSize = 50): Promise<number> {
  const chunks = await query<{ id: string; text: string }>(
    `SELECT id, text FROM chunks WHERE embedding IS NULL LIMIT $1`,
    [batchSize]
  );

  let count = 0;
  for (const chunk of chunks) {
    const embedding = await embedOne(chunk.text);
    await query(
      `UPDATE chunks SET embedding = $1::vector WHERE id = $2`,
      [toVectorString(embedding), chunk.id]
    );
    count++;
  }
  return count;
}
