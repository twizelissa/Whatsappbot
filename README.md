# UniPods WhatsApp Group Memory Bot

> 🏆 UniPods Hackathon submission — AI-powered WhatsApp group memory bot that ingests group chats + call recordings and answers questions with cited sources.

## What it does

- **Listens** to your WhatsApp group in real-time (read-only)
- **Transcribes** call recordings automatically (Whisper)
- **Embeds** every message and transcript segment on receipt — no batching
- **Answers** questions via DM or group @mention with source citations
- **Detects** duplicate questions and points to prior discussions
- **Posts** daily/weekly digests and auto call recaps unprompted

## Architecture

```
WhatsApp Group ──(Baileys, read-only)──▶ Ingestion ──▶ Embed ──▶ Supabase pgvector
                                                                        ▲
Call recording ──▶ Whisper ──▶ same ingestion path ────────────────────┘
                                                                        │
User DMs bot ──(Cloud API webhook)──▶ Answer Service ──▶ Hybrid Search ─▶ LLM ─▶ Reply
```

## Project structure

```
packages/
  ingestion/     # Baileys listener (read-only WhatsApp)
  transcription/ # Whisper call transcription pipeline
  answer/        # WhatsApp Cloud API webhook + LLM answer generation
  scheduler/     # Digest, recap, duplicate detection jobs
  shared/        # Shared DB, embeddings, retrieval, types
dashboard/       # Next.js admin dashboard
supabase/
  migrations/    # Postgres + pgvector schema
```

## Setup

### 1. Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project (free tier is fine)
- [Meta Developer App](https://developers.facebook.com) with WhatsApp Business Cloud API
- OpenAI or Anthropic API key
- A **dedicated phone number** for Baileys (never a personal number)

### 2. Clone and install

```bash
git clone https://github.com/your-org/unipods-whatsapp-bot.git
cd unipods-whatsapp-bot
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in all values in `.env` (see comments in the file).

### 4. Set up the database

In your Supabase SQL editor, run both migration files in order:

```sql
-- Run supabase/migrations/001_initial_schema.sql
-- Run supabase/migrations/002_functions.sql
```

### 5. Start services

**Development (all services):**
```bash
npm run dev
```

**Individual services:**
```bash
npm run dev:ingestion    # Baileys listener (port 3002)
npm run dev:answer       # Answer webhook (port 3000)
npm run dev:scheduler    # Scheduler jobs (port 3001)
npm run dev:dashboard    # Admin dashboard (port 3000 → use 4000)
```

### 6. Link Baileys number

On first run of the ingestion service, a QR code will appear in the terminal.
Scan it with the **dedicated phone number** (not a personal number).

> ⚠️ **Important**: Do this 3-4 days before demo day to let the number "age".

### 7. Configure WhatsApp webhook

In your Meta Developer App:
1. Go to WhatsApp → Configuration
2. Set webhook URL: `https://your-domain.com/webhook`
3. Set verify token: same as `WHATSAPP_VERIFY_TOKEN` in `.env`
4. Subscribe to `messages` field

For local development, use [ngrok](https://ngrok.com):
```bash
ngrok http 3000
# Copy the HTTPS URL and set it as your webhook URL
```

### 8. Upload a call recording (optional)

```bash
curl -X POST http://localhost:3003/transcribe \
  -F "file=@recording.mp4" \
  -F "call_date=2024-09-15"
```

Or just drop the file in the `recordings/` folder — it auto-transcribes.

## Environment Variables

See `.env.example` for all required variables with descriptions.

## Demo quick test

```bash
# Test the Q&A without WhatsApp
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What was decided in the last meeting?"}'
```

## Manual digest trigger (demo)

```bash
# Trigger daily digest immediately
curl -X POST http://localhost:3001/trigger/daily-digest

# Trigger call recap for a specific call
curl -X POST http://localhost:3001/trigger/call-recap/your-call-id
```

## Deployment

Recommended: [Railway](https://railway.app) or [Render](https://render.com) — free tier sufficient.

Each package is a separate service:
- `packages/ingestion` → `npm start`
- `packages/answer` → `npm start`  
- `packages/scheduler` → `npm start`
- `dashboard` → `npm start`

Set all `.env` values as environment variables in your hosting platform.

## Submission checklist

- [x] Working bot, live and testable
- [x] GitHub repo access
- [x] Setup notes (this README)
- [ ] Team declaration sent
- [ ] Ready for judging window (Fri 18 Sept – Thu 24 Sept)
