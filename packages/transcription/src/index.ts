import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import getEnv from '@unipods/shared/src/config';
import { transcribeAndIngest } from './transcriber';
import { watchRecordingsDir } from './watcher';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });
const env = getEnv();

const RECORDINGS_DIR = path.resolve(env.RECORDINGS_DIR);
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Multer config for file uploads
const upload = multer({
  dest: path.join(RECORDINGS_DIR, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm', 'video/mp4', 'video/webm', 'audio/x-m4a'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'transcription', timestamp: new Date().toISOString() });
});

// Upload and transcribe endpoint
app.post(
  '/transcribe',
  upload.single('file') as express.RequestHandler,
  async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const callDate = req.body.call_date ? new Date(req.body.call_date) : new Date();
    const callId = req.body.call_id ?? path.basename(file.originalname, path.extname(file.originalname));

    // Rename to proper extension
    const ext = path.extname(file.originalname);
    const renamedPath = file.path + ext;
    fs.renameSync(file.path, renamedPath);

    logger.info({ callId, originalName: file.originalname }, '📤 Manual upload received, transcribing...');

    try {
      const resultCallId = await transcribeAndIngest(renamedPath, callId, callDate);
      fs.unlinkSync(renamedPath); // clean up
      res.json({ success: true, call_id: resultCallId, message: 'Transcription complete and ingested' });
    } catch (err) {
      logger.error({ err }, 'Transcription failed');
      if (fs.existsSync(renamedPath)) fs.unlinkSync(renamedPath);
      res.status(500).json({ error: 'Transcription failed', details: String(err) });
    }
  }
);

// List processed transcripts
app.get('/transcripts', async (_req: Request, res: Response) => {
  const { query } = await import('@unipods/shared/src/db');
  const rows = await query<{ call_id: string; created_at: Date; text: string }>(
    `SELECT DISTINCT call_id, MIN(created_at) as created_at,
     STRING_AGG(text, ' ' ORDER BY timestamp) as text
     FROM transcripts GROUP BY call_id ORDER BY created_at DESC LIMIT 20`
  );
  res.json(rows);
});

// Start watcher and server
watchRecordingsDir(async (callId, filePath) => {
  logger.info({ callId, filePath }, '🔔 Auto-recap triggered for new transcript');
  // The scheduler service will pick this up via DB polling
});

const PORT = env.INGESTION_PORT + 1; // 3003
app.listen(PORT, () => {
  logger.info(`🎙️ Transcription service running on port ${PORT}`);
});
