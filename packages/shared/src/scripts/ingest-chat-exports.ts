import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';
import { embedOne, toVectorString } from '../embeddings';
import { ChunkMetadata } from '../types';

export interface ExportMessage {
  id: string;
  sender: string;
  senderName: string;
  timestamp: Date;
  text: string;
  groupId: string;
}

const HEADER_REGEX = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)\]\s+(?:-\s+)?(.*)$/i;

function parseDate(dateStr: string, timeStr: string): Date {
  try {
    const parts = dateStr.split('/');
    let month = parseInt(parts[0], 10);
    let day = parseInt(parts[1], 10);
    let year = parseInt(parts[2], 10);
    if (year < 100) year += 2000;

    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)$/i);
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    if (timeMatch) {
      hours = parseInt(timeMatch[1], 10);
      minutes = parseInt(timeMatch[2], 10);
      seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
      const ampm = timeMatch[4].toUpperCase();
      if (ampm === 'PM' && hours < 12) hours += 12;
      if (ampm === 'AM' && hours === 12) hours = 0;
    }
    return new Date(year, month - 1, day, hours, minutes, seconds);
  } catch {
    return new Date();
  }
}

export function parseChatExport(filePath: string, groupId: string): ExportMessage[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const messages: ExportMessage[] = [];

  let currentMsg: ExportMessage | null = null;

  for (const line of lines) {
    const match = line.match(HEADER_REGEX);
    if (match) {
      if (currentMsg) {
        messages.push(currentMsg);
        currentMsg = null;
      }

      const dateStr = match[1];
      const timeStr = match[2];
      const rest = match[3];

      const timestamp = parseDate(dateStr, timeStr);

      let sender = 'System';
      let senderName = 'System';
      let text = rest;

      const colonIdx = rest.indexOf(': ');
      if (colonIdx !== -1) {
        senderName = rest.substring(0, colonIdx).trim();
        sender = senderName;
        text = rest.substring(colonIdx + 2).trim();
      }

      currentMsg = {
        id: uuidv4(),
        sender,
        senderName,
        timestamp,
        text,
        groupId,
      };
    } else {
      if (currentMsg) {
        currentMsg.text += '\n' + line;
      }
    }
  }

  if (currentMsg) {
    messages.push(currentMsg);
  }

  return messages;
}

export function createChunksFromMessages(messages: ExportMessage[], groupId: string, chunkSize = 12, overlap = 3) {
  const userMessages = messages.filter(
    (m) => m.sender !== 'System' && m.text.trim().length > 0 && !m.text.includes('This message was deleted')
  );

  const chunks: { text: string; sourceId: string; metadata: ChunkMetadata }[] = [];

  for (let i = 0; i < userMessages.length; i += chunkSize - overlap) {
    const slice = userMessages.slice(i, i + chunkSize);
    if (slice.length === 0) break;

    const startDate = slice[0].timestamp.toLocaleDateString();
    const endDate = slice[slice.length - 1].timestamp.toLocaleDateString();
    const senders = Array.from(new Set(slice.map((s) => s.senderName)));

    const header = `=== Group: ${groupId} | Date: ${startDate} to ${endDate} ===\n`;
    const body = slice.map((m) => `[${m.senderName}]: ${m.text}`).join('\n');
    const fullText = header + body;

    chunks.push({
      text: fullText,
      sourceId: slice[0].id,
      metadata: {
        date: slice[0].timestamp.toISOString(),
        sender: senders.join(', '),
        sender_name: senders.join(', '),
        source_type: 'message',
        group_id: groupId,
      },
    });

    if (i + chunkSize >= userMessages.length) break;
  }

  return chunks;
}

async function embedWithRetry(text: string, retries = 5, delay = 2500): Promise<number[]> {
  for (let i = 0; i < retries; i++) {
    try {
      return await embedOne(text);
    } catch (err: any) {
      if (err?.status === 429 || String(err).includes('429')) {
        const waitTime = delay * (i + 1);
        console.warn(`  ⚠️ Gemini Rate Limit (429). Pausing ${waitTime / 1000}s before retry ${i + 1}...`);
        await new Promise((res) => setTimeout(res, waitTime));
      } else {
        throw err;
      }
    }
  }
  return await embedOne(text);
}

export async function ingestPdfDocuments(folderPath: string, groupId: string) {
  if (!fs.existsSync(folderPath)) return;
  const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.pdf'));
  const { execSync } = require('child_process');

  for (const fileName of files) {
    const filePath = path.join(folderPath, fileName);
    console.log(`\n📄 Parsing PDF Resource: "${fileName}" in ${groupId}...`);
    try {
      const fullText = execSync(`pdftotext "${filePath}" -`, { encoding: 'utf-8' });
      if (!fullText || fullText.trim().length < 20) {
        console.warn(`  ⚠️ Skipped empty or unparseable PDF: ${fileName}`);
        continue;
      }

      const paragraphs = fullText.split(/\n\s*\n/);
      const chunks: string[] = [];
      let currentChunk = `=== DOCUMENT: ${fileName} | Group: ${groupId} ===\n`;

      for (const p of paragraphs) {
        const clean = p.trim();
        if (!clean) continue;
        if ((currentChunk + '\n' + clean).length > 800) {
          chunks.push(currentChunk);
          currentChunk = `=== DOCUMENT: ${fileName} | Group: ${groupId} ===\n` + clean;
        } else {
          currentChunk += '\n' + clean;
        }
      }
      if (currentChunk.trim().length > 50) {
        chunks.push(currentChunk);
      }

      console.log(`  └─ Created ${chunks.length} document chunks for "${fileName}".`);

      let docEmbedded = 0;
      for (const chunkText of chunks) {
        try {
          const embedding = await embedWithRetry(chunkText);
          const chunkId = uuidv4();
          await query(
            `INSERT INTO chunks (id, source_id, source_type, text, embedding, metadata)
             VALUES ($1, $2, $3, $4, $5::vector, $6)`,
            [
              chunkId,
              chunkId,
              'document',
              chunkText,
              toVectorString(embedding),
              JSON.stringify({
                source_type: 'document',
                file_name: fileName,
                group_id: groupId,
                date: new Date().toISOString(),
              }),
            ]
          );
          docEmbedded++;
          await new Promise((r) => setTimeout(r, 200));
        } catch (e) {
          console.error(`  ⚠️ Error embedding PDF chunk:`, e);
        }
      }
      console.log(`  ✅ Successfully ingested "${fileName}": ${docEmbedded} chunks embedded.`);
    } catch (err) {
      console.error(`  ❌ Failed to parse PDF "${fileName}":`, err);
    }
  }
}

export async function runIngestion() {
  const rootDir = path.resolve(__dirname, '../../../../');
  const groupsToIngest = [
    {
      folder: 'Domari BG Funding links',
      file: path.join(rootDir, 'Domari BG Funding links', 'chat.txt'),
      groupId: 'Domari BG Funding links',
    },
    {
      folder: 'UniPods METI AI Program 2026 Cohort',
      file: path.join(rootDir, 'UniPods METI AI Program 2026 Cohort', 'chat.txt'),
      groupId: 'UniPods METI AI Program 2026 Cohort',
    },
    {
      folder: 'Wadhwani UniPod AI Program Africa',
      file: path.join(rootDir, 'Wadhwani UniPod AI Program Africa', 'chat.txt'),
      groupId: 'Wadhwani UniPod AI Program Africa',
    },
  ];

  console.log('🚀 Starting Robust Chat Export & PDF Document Ingestion Pipeline...');

  for (const group of groupsToIngest) {
    const folderPath = path.join(rootDir, group.folder);

    // 1. Ingest PDF Documents in group folder
    await ingestPdfDocuments(folderPath, group.groupId);

    // 2. Ingest Chat Exports
    console.log(`\n📁 Processing chat export "${group.groupId}" from ${group.file}`);
    if (!fs.existsSync(group.file)) {
      console.error(`❌ File not found: ${group.file}`);
      continue;
    }

    const messages = parseChatExport(group.file, group.groupId);
    console.log(`  └─ Parsed ${messages.length} total messages.`);

    const BATCH_SIZE = 100;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      const valueStrings: string[] = [];
      const queryParams: any[] = [];
      let paramIdx = 1;

      for (const msg of batch) {
        valueStrings.push(
          `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, 'whatsapp', $${paramIdx++}, $${paramIdx++})`
        );
        queryParams.push(
          msg.id,
          msg.sender,
          msg.senderName,
          msg.timestamp,
          msg.text,
          msg.groupId,
          JSON.stringify({ folder: group.folder, exported: true })
        );
      }

      const sql = `INSERT INTO messages (id, sender, sender_name, timestamp, text, source, group_id, metadata)
                   VALUES ${valueStrings.join(', ')}
                   ON CONFLICT (id) DO NOTHING`;
      await query(sql, queryParams);
    }
    console.log(`  └─ Inserted ${messages.length} raw messages to DB (batched).`);

    const chunks = createChunksFromMessages(messages, group.groupId, 12, 3);
    console.log(`  └─ Created ${chunks.length} text chunks for vector embedding.`);

    let embeddedCount = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const embedding = await embedWithRetry(chunk.text);
        await query(
          `INSERT INTO chunks (id, source_id, source_type, text, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5::vector, $6)`,
          [
            uuidv4(),
            chunk.sourceId,
            'message',
            chunk.text,
            toVectorString(embedding),
            JSON.stringify(chunk.metadata),
          ]
        );
        embeddedCount++;
        if (embeddedCount % 10 === 0 || embeddedCount === chunks.length) {
          console.log(`     Progress: ${embeddedCount}/${chunks.length} chunks embedded & inserted.`);
        }
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.error(`  ⚠️ Error embedding chunk ${i + 1}:`, err);
      }
    }
    console.log(`  ✅ Finished "${group.groupId}": ${embeddedCount} chunks stored with embeddings.`);
  }

  console.log('\n🎉 ALL HISTORICAL CHATS AND PDF DOCUMENTS HAVE BEEN SUCCESSFULLY INGESTED AND EMBEDDED!');
  process.exit(0);
}

if (require.main === module) {
  runIngestion().catch((err) => {
    console.error('Fatal error during ingestion:', err);
    process.exit(1);
  });
}
