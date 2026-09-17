import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
import getEnv from '@unipods/shared/src/config';
import { ingestTranscript } from '@unipods/shared/src/ingest';
import { Transcript } from '@unipods/shared/src/types';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    const env = getEnv();
    _openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return _openai;
}

export interface TranscriptionResult {
  callId: string;
  text: string;
  segments: TranscriptSegment[];
}

export interface TranscriptSegment {
  start: number;  // seconds
  end: number;
  text: string;
  speaker?: string;
}

/**
 * Transcribe an audio/video file using OpenAI Whisper API.
 * Returns full transcript with time-stamped segments.
 */
export async function transcribeFile(
  filePath: string,
  callId?: string
): Promise<TranscriptionResult> {
  const env = getEnv();
  const resolvedCallId = callId ?? uuidv4();

  logger.info({ filePath, callId: resolvedCallId }, '🎙️ Starting transcription...');

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileStream = createReadStream(filePath);
  const fileName = path.basename(filePath);

  const result = await getOpenAI().audio.transcriptions.create({
    file: fileStream as unknown as File,
    model: env.WHISPER_MODEL,
    response_format: 'verbose_json', // includes timestamps
    timestamp_granularities: ['segment'],
    language: 'en',
  });

  const segments: TranscriptSegment[] = (result as unknown as {
    segments?: Array<{ start: number; end: number; text: string }>;
  }).segments?.map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text.trim(),
  })) ?? [{ start: 0, end: 0, text: result.text }];

  logger.info(
    { callId: resolvedCallId, segments: segments.length, chars: result.text.length },
    '✅ Transcription complete'
  );

  return {
    callId: resolvedCallId,
    text: result.text,
    segments,
  };
}

/**
 * Process a transcription result and ingest into the DB/vector store.
 * Chunks transcripts by time (30s windows) for better retrieval.
 */
export async function processAndIngestTranscript(
  result: TranscriptionResult,
  callDate?: Date
): Promise<void> {
  const date = callDate ?? new Date();

  // Group segments into ~30s chunks for embedding
  const chunks: Omit<Transcript, 'id'>[] = [];
  const CHUNK_SECONDS = 30;

  let currentChunk: TranscriptSegment[] = [];
  let chunkStart = result.segments[0]?.start ?? 0;

  for (const seg of result.segments) {
    currentChunk.push(seg);

    if (seg.end - chunkStart >= CHUNK_SECONDS) {
      const text = currentChunk.map((s) => s.text).join(' ');
      chunks.push({
        call_id: result.callId,
        timestamp: chunkStart,
        speaker: currentChunk[0]?.speaker ?? null,
        text,
        metadata: {
          start: chunkStart,
          end: seg.end,
          date: date.toISOString(),
          file_name: result.callId,
        },
      });
      currentChunk = [];
      chunkStart = seg.end;
    }
  }

  // Flush remaining
  if (currentChunk.length > 0) {
    const text = currentChunk.map((s) => s.text).join(' ');
    chunks.push({
      call_id: result.callId,
      timestamp: chunkStart,
      speaker: currentChunk[0]?.speaker ?? null,
      text,
      metadata: { date: date.toISOString() },
    });
  }

  logger.info({ callId: result.callId, chunks: chunks.length }, '📦 Ingesting transcript chunks...');
  await ingestTranscript(chunks, result.callId);
  logger.info({ callId: result.callId }, '✅ Transcript fully embedded and stored');
}

/**
 * One-shot: transcribe a file and ingest everything.
 */
export async function transcribeAndIngest(
  filePath: string,
  callId?: string,
  callDate?: Date
): Promise<string> {
  const result = await transcribeFile(filePath, callId);
  await processAndIngestTranscript(result, callDate);
  return result.callId;
}
