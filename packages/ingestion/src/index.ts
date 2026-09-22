import express from 'express';
import { startBaileysListener, joinGroup, getActiveGroupsInfo, restartBaileysListener } from './listener';
import { getEnv } from '@unipods/shared';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

let latestQrDataUrl: string | null = null;

export function updateLatestQr(qrDataUrl: string | null): void {
  latestQrDataUrl = qrDataUrl;
}

async function main(): Promise<void> {
  const env = getEnv();

  // Health check server & Web QR Code viewer
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.redirect('/qr');
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'ingestion', timestamp: new Date().toISOString() });
  });

  app.get('/groups', (_req, res) => {
    const groups = getActiveGroupsInfo();
    res.json({ count: groups.length, groups });
  });

  app.post('/join-group', async (req, res) => {
    const { invite_link } = req.body;
    if (!invite_link) {
      return res.status(400).json({ success: false, message: 'invite_link is required' });
    }
    const result = await joinGroup(invite_link);
    res.json(result);
  });

  app.post('/restart', async (_req, res) => {
    logger.info('🔄 Received restart request via HTTP');
    const result = await restartBaileysListener();
    res.json(result);
  });

  app.get('/qr', (_req, res) => {
    if (!latestQrDataUrl) {
      res.send(`
        <html>
          <head><meta http-equiv="refresh" content="2"></head>
          <body style="font-family:sans-serif; background:#0b141a; color:#e9edef; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0;">
            <h2>⏳ Waiting for WhatsApp QR Code...</h2>
            <p style="color:#8696a0;">If already connected, no QR code is needed. Page refreshes every 2 seconds.</p>
          </body>
        </html>
      `);
      return;
    }
    res.send(`
      <html>
        <head>
          <title>WhatsApp Bot QR Code</title>
          <meta http-equiv="refresh" content="10">
        </head>
        <body style="font-family:sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; background:#0b141a; color:#e9edef; margin:0;">
          <h2 style="margin-bottom:8px;">📱 Link WhatsApp Bot</h2>
          <p style="color:#8696a0; margin-bottom:24px;">WhatsApp → Settings → Linked Devices → Link a Device</p>
          <div style="background:white; padding:24px; border-radius:20px; box-shadow: 0 12px 32px rgba(0,0,0,0.6);">
            <img src="${latestQrDataUrl}" style="width:320px; height:320px; display:block;" />
          </div>
          <p style="font-size:13px; color:#8696a0; margin-top:24px;">Auto-refreshes every 10 seconds</p>
        </body>
      </html>
    `);
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : env.INGESTION_PORT;
  app.listen(port, () => {
    logger.info(`🚀 Ingestion health check & Web QR on http://localhost:${port}/qr`);
  });

  // Start Baileys
  logger.info('🎯 Starting UniPods Ingestion Listener (read-only mode)...');
  await startBaileysListener();
}

main().catch((err) => {
  console.error('Fatal error in ingestion service:', err);
  process.exit(1);
});
