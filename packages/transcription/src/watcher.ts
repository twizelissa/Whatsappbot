import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';
import getEnv from '@unipods/shared/src/config';
import { transcribeAndIngest } from './transcriber';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

const SUPPORTED_EXTENSIONS = ['.mp3', '.mp4', '.m4a', '.wav', '.ogg', '.webm', '.flac'];

/**
 * Watch the recordings directory for new audio/video files
 * and automatically transcribe + ingest them.
 */
export function watchRecordingsDir(onTranscribed?: (callId: string, filePath: string) => Promise<void>): void {
  const env = getEnv();
  const recordingsDir = path.resolve(env.RECORDINGS_DIR);

  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  logger.info({ recordingsDir }, '👁️ Watching recordings directory...');

  const watcher = chokidar.watch(recordingsDir, {
    ignored: /node_modules/,
    persistent: true,
    ignoreInitial: false,  // process existing files on startup
    awaitWriteFinish: {
      stabilityThreshold: 3000, // wait 3s after last write to ensure file is complete
      pollInterval: 500,
    },
  });

  const processing = new Set<string>();

  watcher.on('add', async (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) return;
    if (processing.has(filePath)) return;

    processing.add(filePath);

    try {
      logger.info({ filePath }, '🎬 New recording detected, transcribing...');

      // Parse call date from filename if possible: YYYY-MM-DD_HH-MM-SS_callid.mp4
      const fileName = path.basename(filePath, ext);
      const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})/);
      const callDate = dateMatch ? new Date(dateMatch[1]) : new Date();
      const callId = fileName.replace(/[^a-zA-Z0-9-_]/g, '-');

      const resultCallId = await transcribeAndIngest(filePath, callId, callDate);
      logger.info({ callId: resultCallId, filePath }, '✅ Recording transcribed and ingested');

      // Move to processed folder
      const processedDir = path.join(recordingsDir, 'processed');
      if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });
      fs.renameSync(filePath, path.join(processedDir, path.basename(filePath)));

      if (onTranscribed) {
        await onTranscribed(resultCallId, filePath);
      }
    } catch (err) {
      logger.error({ err, filePath }, '❌ Failed to transcribe recording');
    } finally {
      processing.delete(filePath);
    }
  });

  watcher.on('error', (err) => {
    logger.error({ err }, 'Watcher error');
  });
}
