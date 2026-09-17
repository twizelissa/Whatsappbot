import express from 'express';
import getEnv from '@unipods/shared/src/config';
import { startScheduler, runDailyDigest, runWeeklyDigest, runCallRecap } from './jobs';
import pino from 'pino';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });
const env = getEnv();
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'scheduler', timestamp: new Date().toISOString() });
});

// Manual trigger endpoints (useful for demos)
app.post('/trigger/daily-digest', async (_req, res) => {
  try {
    await runDailyDigest();
    res.json({ success: true, message: 'Daily digest sent' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/trigger/weekly-digest', async (_req, res) => {
  try {
    await runWeeklyDigest();
    res.json({ success: true, message: 'Weekly digest sent' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/trigger/call-recap/:callId', async (req, res) => {
  try {
    await runCallRecap(req.params.callId);
    res.json({ success: true, message: `Recap sent for call ${req.params.callId}` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

startScheduler();

app.listen(env.SCHEDULER_PORT, () => {
  logger.info(`⏰ Scheduler service running on port ${env.SCHEDULER_PORT}`);
});
