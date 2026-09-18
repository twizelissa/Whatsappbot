/**
 * Microsoft Teams Recording Poller
 *
 * Teams automatically saves call recordings to OneDrive/SharePoint.
 * This module polls the Microsoft Graph API for new recordings and
 * transcribes them via Whisper.
 *
 * Setup:
 *   1. Azure Portal → App Registrations → New registration
 *   2. Add API permissions: Files.Read.All, CallRecords.Read.All, User.Read.All
 *   3. Grant admin consent
 *   4. Create a client secret → copy to TEAMS_CLIENT_SECRET
 *   5. Copy Application (client) ID → TEAMS_CLIENT_ID
 *   6. Copy Directory (tenant) ID → TEAMS_TENANT_ID
 */

import fs from 'fs';
import path from 'path';
import pino from 'pino';
import getEnv from '@unipods/shared/src/config';
import { transcribeAndIngest } from './transcriber';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Tracks recording IDs we've already processed so we don't re-transcribe
const processedRecordingIds = new Set<string>();

// ─────────────────────────────────────────────────────────────────────────────
// Token management
// ─────────────────────────────────────────────────────────────────────────────

interface TokenCache {
  access_token: string;
  expires_at: number; // epoch ms
}

let tokenCache: TokenCache | null = null;

async function getGraphToken(): Promise<string> {
  const env = getEnv();

  if (
    tokenCache &&
    tokenCache.expires_at > Date.now() + 60_000 // refresh 1 min early
  ) {
    return tokenCache.access_token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.TEAMS_CLIENT_ID!,
    client_secret: env.TEAMS_CLIENT_SECRET!,
    scope: 'https://graph.microsoft.com/.default',
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${env.TEAMS_TENANT_ID}/oauth2/v2.0/token`,
    { method: 'POST', body }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Teams OAuth token fetch failed: ${err}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  return tokenCache.access_token;
}

async function graphGet<T>(endpoint: string): Promise<T> {
  const token = await getGraphToken();
  const res = await fetch(`${GRAPH_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph API error on ${endpoint}: ${err}`);
  }

  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording discovery
// ─────────────────────────────────────────────────────────────────────────────

interface DriveItem {
  id: string;
  name: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  size: number;
  file?: { mimeType: string };
  '@microsoft.graph.downloadUrl'?: string;
}

interface DriveItemResponse {
  value: DriveItem[];
}

/**
 * Search for Teams meeting recordings across all users' OneDrive.
 * Teams recordings are typically named "Recording YYYY-MM-DD..." and stored
 * in the user's "Recordings" folder in OneDrive for Business.
 */
async function findNewRecordings(lookBackDays: number): Promise<DriveItem[]> {
  const env = getEnv();

  // If a specific user or drive ID is configured, use that. Otherwise search all.
  const sinceDate = new Date(Date.now() - lookBackDays * 24 * 60 * 60 * 1000).toISOString();

  let endpoint: string;

  if (env.TEAMS_USER_ID) {
    // Search a specific user's OneDrive (most common setup)
    endpoint = `/users/${env.TEAMS_USER_ID}/drive/root/search(q='Recording')` +
      `?$filter=createdDateTime ge ${sinceDate}` +
      `&$select=id,name,createdDateTime,lastModifiedDateTime,size,file,@microsoft.graph.downloadUrl` +
      `&$top=50`;
  } else {
    // Search the org-wide SharePoint (requires broader permissions)
    endpoint = `/sites/root/drive/root/search(q='Recording')` +
      `?$filter=createdDateTime ge ${sinceDate}` +
      `&$select=id,name,createdDateTime,lastModifiedDateTime,size,file,@microsoft.graph.downloadUrl` +
      `&$top=50`;
  }

  const data = await graphGet<DriveItemResponse>(endpoint);

  // Filter: only video/audio files, not already processed, created after lookback
  const SUPPORTED_MIME = [
    'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4',
    'audio/ogg', 'audio/wav', 'audio/x-m4a',
  ];

  return (data.value ?? []).filter((item) => {
    if (processedRecordingIds.has(item.id)) return false;
    if (!item.file) return false; // folders
    if (!SUPPORTED_MIME.includes(item.file.mimeType)) return false;

    // Teams recordings include "Recording" in the name
    const lowerName = item.name.toLowerCase();
    if (!lowerName.includes('recording') && !lowerName.includes('meeting')) return false;

    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Download + Transcribe
// ─────────────────────────────────────────────────────────────────────────────

async function downloadRecording(item: DriveItem, destDir: string): Promise<string> {
  const token = await getGraphToken();
  const env = getEnv();

  // Prefer the pre-authenticated download URL from the drive item
  const downloadUrl = item['@microsoft.graph.downloadUrl'] ??
    `${GRAPH_BASE}/users/${env.TEAMS_USER_ID}/drive/items/${item.id}/content`;

  const res = await fetch(downloadUrl, {
    headers: item['@microsoft.graph.downloadUrl']
      ? {} // pre-auth URL doesn't need token
      : { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) throw new Error(`Failed to download recording ${item.name}: ${res.statusText}`);

  const ext = path.extname(item.name) || '.mp4';
  const safeId = item.id.replace(/[^a-zA-Z0-9-_]/g, '-');
  const destPath = path.join(destDir, `teams-${safeId}${ext}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);

  logger.info({ name: item.name, size: item.size, destPath }, '⬇️  Recording downloaded');
  return destPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Poller
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamsPollerOptions {
  pollIntervalMs?: number;   // default: 5 minutes
  lookBackDays?: number;     // default: 7
  onTranscribed?: (callId: string) => Promise<void>;
}

export async function startTeamsRecordingPoller(opts: TeamsPollerOptions = {}): Promise<void> {
  const env = getEnv();

  if (!env.TEAMS_CLIENT_ID || !env.TEAMS_CLIENT_SECRET || !env.TEAMS_TENANT_ID) {
    logger.warn(
      '⚠️  Teams credentials not configured (TEAMS_CLIENT_ID / TEAMS_CLIENT_SECRET / TEAMS_TENANT_ID). ' +
      'Teams recording poller is disabled. Set these in .env to enable.'
    );
    return;
  }

  const {
    pollIntervalMs = 5 * 60 * 1000, // 5 minutes
    lookBackDays = 7,
    onTranscribed,
  } = opts;

  const tempDir = path.resolve(env.RECORDINGS_DIR, 'teams-downloads');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  logger.info(
    { pollIntervalMs, lookBackDays },
    '📡 Teams recording poller started'
  );

  const poll = async () => {
    try {
      const recordings = await findNewRecordings(lookBackDays);

      if (recordings.length === 0) {
        logger.debug('Teams poll: no new recordings found');
        return;
      }

      logger.info({ count: recordings.length }, '🎬 Found new Teams recordings');

      for (const item of recordings) {
        try {
          // Parse call date from filename or use creation date
          const createdDate = new Date(item.createdDateTime);
          const callId = `teams-${item.id.slice(0, 16)}`;

          // Download
          const filePath = await downloadRecording(item, tempDir);

          // Mark as processed before transcribing (prevents double-processing if crash)
          processedRecordingIds.add(item.id);

          // Transcribe + ingest via shared Whisper pipeline
          const resultCallId = await transcribeAndIngest(filePath, callId, createdDate);

          // Clean up temp file
          fs.unlinkSync(filePath);

          logger.info({ callId: resultCallId, name: item.name }, '✅ Teams recording transcribed & ingested');

          if (onTranscribed) {
            await onTranscribed(resultCallId);
          }
        } catch (err) {
          logger.error({ err, recordingName: item.name }, '❌ Failed to process Teams recording');
          // Don't add to processedRecordingIds — will retry next poll
        }
      }
    } catch (err) {
      logger.error({ err }, '❌ Teams poll cycle failed');
    }
  };

  // Run immediately, then on interval
  await poll();
  setInterval(poll, pollIntervalMs);
}
