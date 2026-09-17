import express from 'express';
import { startBaileysListener } from './listener';
import getEnv from '@unipods/shared/src/config';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

async function main(): Promise<void> {
  const env = getEnv();

  // Health check server (for Railway/Render deployment)
  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'ingestion', timestamp: new Date().toISOString() });
  });

  app.listen(env.INGESTION_PORT, () => {
    logger.info(`🚀 Ingestion health check on port ${env.INGESTION_PORT}`);
  });

  // Start Baileys
  logger.info('🎯 Starting UniPods Ingestion Listener (read-only mode)...');
  await startBaileysListener();
}

main().catch((err) => {
  console.error('Fatal error in ingestion service:', err);
  process.exit(1);
});
