/**
 * Google Meet Recording Poller
 *
 * Google Meet recordings are automatically saved to Google Drive in the
 * meeting organiser's "Meet Recordings" folder.
 *
 * This module polls that folder every N minutes, downloads any new recordings
 * it hasn't seen before, transcribes them with Whisper, and ingests them.
 *
 * Setup required (one-time):
 *  1. Google Cloud Console → enable Drive API + Meet API
 *  2. Create a Service Account, share the "Meet Recordings" Drive folder with it
 *  3. Download the service account JSON key → GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env
 *     OR set GOOGLE_SERVICE_ACCOUNT_KEY_JSON with the raw JSON string (for hosting envs)
 *
 * Alternatively use OAuth2 (for personal account):
 *  Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
 */

import { google, drive_v3 } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import pino from 'pino';
import { transcribeAndIngest } from './transcriber';
import getEnv from '@unipods/shared/src/config';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

// ── Auth ───────────────────────────────────────────────────────────────────────

function buildGoogleAuth() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;

  if (keyFile && fs.existsSync(keyFile)) {
    return new google.auth.GoogleAuth({
      keyFile,
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/meetings.space.readonly',
      ],
    });
  }

  if (keyJson) {
    const credentials = JSON.parse(keyJson);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/meetings.space.readonly',
      ],
    });
  }

  // OAuth2 fallback (personal account)
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return oauth2;
  }

  return null;
}

// ── Seen-files tracker (persisted to disk) ────────────────────────────────────

const SEEN_FILES_PATH = path.resolve('.google-drive-seen.json');

function loadSeenFiles(): Set<string> {
  try {
    if (fs.existsSync(SEEN_FILES_PATH)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILES_PATH, 'utf-8')) as string[];
      return new Set(data);
    }
  } catch {}
  return new Set();
}

function saveSeenFiles(seen: Set<string>): void {
  fs.writeFileSync(SEEN_FILES_PATH, JSON.stringify([...seen]), 'utf-8');
}

// ── Download a Drive file to a local temp path ────────────────────────────────

async function downloadDriveFile(
  drive: drive_v3.Drive,
  fileId: string,
  fileName: string,
  destDir: string
): Promise<string> {
  const destPath = path.join(destDir, fileName);

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    (res.data as Readable).pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  return destPath;
}

// ── List Meet recordings from Drive ──────────────────────────────────────────

/**
 * Google Meet recordings land in Google Drive.
 * They can be in two places:
 *   a) A shared folder you specify (GOOGLE_DRIVE_RECORDINGS_FOLDER_ID)
 *   b) Searched by mimeType + name pattern ("Meet Recording" in the name)
 *
 * We support both: folder ID takes priority.
 */
async function listNewMeetRecordings(
  drive: drive_v3.Drive,
  since: Date,
  folderId?: string
): Promise<drive_v3.Schema$File[]> {
  const sinceIso = since.toISOString();

  let query: string;
  if (folderId) {
    query = `'${folderId}' in parents and mimeType contains 'video/' and createdTime > '${sinceIso}' and trashed = false`;
  } else {
    // Fallback: search by name pattern across all of Drive
    query = `(name contains 'Meet Recording' or name contains 'Recording') and mimeType contains 'video/' and createdTime > '${sinceIso}' and trashed = false`;
  }

  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, createdTime, size, mimeType)',
    orderBy: 'createdTime asc',
    pageSize: 50,
  });

  return res.data.files ?? [];
}

// ── Main poll function ────────────────────────────────────────────────────────

export interface DrivePollerOptions {
  pollIntervalMs?: number;          // default: 5 minutes
  folderId?: string;                // GOOGLE_DRIVE_RECORDINGS_FOLDER_ID
  lookBackDays?: number;            // on first run, how far back to look (default: 7 days)
  onTranscribed?: (callId: string) => Promise<void>;
}

let _pollTimer: ReturnType<typeof setInterval> | null = null;

export async function startGoogleMeetPoller(opts: DrivePollerOptions = {}): Promise<void> {
  const {
    pollIntervalMs = 5 * 60 * 1000,  // 5 minutes
    folderId = process.env.GOOGLE_DRIVE_RECORDINGS_FOLDER_ID,
    lookBackDays = 7,
    onTranscribed,
  } = opts;

  const auth = buildGoogleAuth();
  if (!auth) {
    logger.warn(
      '⚠️  No Google credentials found. ' +
      'Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE, GOOGLE_SERVICE_ACCOUNT_KEY_JSON, ' +
      'or GOOGLE_OAUTH_* env vars to enable automatic Google Meet recording ingestion.'
    );
    return;
  }

  const drive = google.drive({ version: 'v3', auth: auth as Parameters<typeof google.drive>[0]['auth'] });

  const env = getEnv();
  const recordingsDir = path.resolve(env.RECORDINGS_DIR);
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

  const tempDir = path.join(recordingsDir, '.google-drive-tmp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const seen = loadSeenFiles();
  let lastChecked = new Date(Date.now() - lookBackDays * 24 * 60 * 60 * 1000);

  logger.info(
    { folderId: folderId ?? 'all-drive-search', pollIntervalMs },
    '📅 Google Meet recording poller started'
  );

  async function poll(): Promise<void> {
    try {
      const files = await listNewMeetRecordings(drive, lastChecked, folderId);
      logger.info({ count: files.length }, '🔍 Drive poll complete');

      for (const file of files) {
        if (!file.id || !file.name) continue;
        if (seen.has(file.id)) continue;

        const fileExt = getExtensionForMimeType(file.mimeType ?? '');
        const fileName = sanitizeFileName(file.name) + fileExt;

        logger.info({ name: file.name, id: file.id, size: file.size }, '⬇️  Downloading Meet recording...');

        try {
          const localPath = await downloadDriveFile(drive, file.id, fileName, tempDir);
          logger.info({ localPath }, '✅ Downloaded');

          const callDate = file.createdTime ? new Date(file.createdTime) : new Date();
          const callId = `gmeet-${sanitizeFileName(file.name)}-${file.id.slice(0, 8)}`;

          const resultCallId = await transcribeAndIngest(localPath, callId, callDate);
          logger.info({ callId: resultCallId }, '✅ Transcribed and ingested from Google Drive');

          // Clean up temp file
          fs.unlinkSync(localPath);

          // Mark as seen
          seen.add(file.id);
          saveSeenFiles(seen);

          if (onTranscribed) await onTranscribed(resultCallId);
        } catch (err) {
          logger.error({ err, fileId: file.id }, '❌ Failed to process Drive recording');
        }
      }

      lastChecked = new Date(); // advance window
    } catch (err) {
      logger.error({ err }, '❌ Drive poll failed');
    }
  }

  // Run immediately, then on interval
  await poll();
  _pollTimer = setInterval(poll, pollIntervalMs);
}

export function stopGoogleMeetPoller(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getExtensionForMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) return '.mp4';
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('ogg')) return '.ogg';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return '.mp3';
  return '.mp4'; // Google Meet recordings are always mp4
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 80);
}
