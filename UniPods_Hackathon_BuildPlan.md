# UniPods Hackathon — WhatsApp Group Memory Bot
## Full Build Plan (for AI coding agent handoff)

---

## 1. Problem Statement (from brief)

Group chat volume is too high — people miss messages, ask already-answered questions, and can't rewatch call recordings. Build a chatbot that ingests chats + calls, makes sense of it, and answers people directly so the group stays informed.

**Deliverables required:** working bot (not a mockup), source code/repo access, short setup notes.

---

## 2. Architecture Overview

Two-tier design, chosen deliberately to balance "wow factor" (real-time, feels alive) against reliability (can't fail mid-demo):

| Tier | Purpose | Tech | Risk |
|---|---|---|---|
| **Answering (front door)** | People ask the bot questions, get replies | WhatsApp Business Cloud API (official) | None — fully sanctioned |
| **Ingestion (memory)** | Capture every group message + call content live | Baileys (read-only listener) + Whisper for calls | Low-moderate, mitigated (see §6) |

Both tiers write to and read from the **same backend and vector store**, so the bot has one unified "brain" regardless of which channel a message came in on.

```
WhatsApp Group ──(Baileys, read-only)──▶ Ingestion Service ──▶ Embed on receipt ──▶ Vector DB (Postgres+pgvector)
                                                                                          ▲
Call recording ──▶ Whisper transcription ──▶ same ingestion path ───────────────────────┘
                                                                                          │
User DMs bot ──(WhatsApp Cloud API webhook)──▶ Answer Service ──▶ Retrieval (hybrid search) ─▶ LLM ─▶ Reply
```

---

## 3. Core Components to Build

### 3.1 Ingestion Listener (Baileys, read-only)
- Connects to WhatsApp using `@whiskeysockets/baileys` on a **dedicated, aged number** (see §6).
- Listens to all messages in the target group.
- **Never sends messages into the group** — read-only, to minimize detection risk.
- On every incoming message: extract sender, timestamp, text, media type/reference, reply-to-thread if present.
- Writes immediately to the DB and triggers embedding — **no batching/cron**, process on receipt so freshly-typed messages are retrievable within seconds.

### 3.2 Call Transcription Pipeline
- Input: recordings from whatever tool the group uses (Zoom/Meet/manual upload to a folder).
- Whisper (API or local) → transcript with timestamps.
- Optional: speaker diarization (`pyannote-audio`) if time allows — otherwise ship without speaker labels for v1.
- Transcripts chunked and pushed into the same ingestion → embedding path as chat messages, tagged `source: call`.

### 3.3 Storage Layer
- **Supabase** project (Postgres + pgvector, free tier, fast to spin up).
- Tables:
  - `messages(id, sender, timestamp, text, source, media_url, reply_to)`
  - `transcripts(id, call_id, timestamp, speaker, text)`
  - `chunks(id, source_id, source_type, text, embedding vector, metadata jsonb)` — metadata includes date, sender/speaker, source type for filtering.

### 3.4 Retrieval Layer (Hybrid Search)
- Combine keyword search (for names, acronyms, project terms) with vector similarity search — group chats are full of proper nouns pure embeddings miss.
- Filter/boost by recency and metadata (source type, sender) — "what was decided recently" is a recency query, not just semantic similarity.
- **Confidence/freshness gate**: if top match relevance is low, or the bot's last-sync timestamp is old relative to "now," don't let the LLM answer confidently — return an honest "I may not have this yet" response instead of guessing.

### 3.5 Answer Generation (LLM)
- Retrieved chunks + user question → LLM (Claude or GPT) → generated answer.
- **Always cite sources**: "According to the call on Sept 12, and a message from [name] on Sept 14…" with date + sender.
- System prompt should explicitly instruct: don't answer beyond retrieved context; if context is insufficient or stale, say so rather than guessing.

### 3.6 WhatsApp Answering Channel (Official Cloud API)
- User DMs the bot's official Business number, or @mentions it in-group (if group messaging becomes available to you — otherwise DM-only).
- Meta sends incoming messages to your webhook → Answer Service → reply sent back via Cloud API.
- This is the channel judges will type into live — it must not depend on the Baileys connection to function for answering (only ingestion depends on Baileys).

### 3.7 Proactive Features (the differentiator — don't skip)
- **Daily/weekly digest**: scheduled job summarizes what happened, posted automatically.
- **Duplicate question detection**: when a question comes in, check if it's already been answered/discussed; if so, answer *and* point to the earlier discussion (directly solves the stated problem).
- **Auto-recap after calls**: once a call transcript is processed, post a short summary unprompted.

### 3.8 Admin Dashboard (optional, good for demo)
- Simple page (Next.js or similar) showing ingested messages/calls live and recent bot answers — lets you visually show "the brain" working during judging, not required for grading but strong demo prop.

---

## 4. Accounts / Setup Needed (all free)

1. **Meta Developer account** → new App → add WhatsApp product → free test number + access token (developers.facebook.com).
2. **Meta Business Account** (business.facebook.com) — link the WABA to it.
3. Add teammates'/demo numbers as verified testers (free tier allows up to 5 verified numbers — enough for a demo).
4. **Supabase** account — Postgres + pgvector + hosting.
5. **LLM API key** — Anthropic or OpenAI, for answer generation.
6. **Embeddings API/model** — OpenAI `text-embedding-3-small`, Voyage, or local `bge-small` (free, zero API cost).
7. **Whisper** — hosted API (simplest) or local install.
8. **Hosting for 24/7 backend** — Railway, Render, or Fly.io (free/cheap tier fine for a week).
9. **A dedicated phone number** for the Baileys ingestion listener — never a team member's personal number (see §6).
10. **GitHub repo** — required for submission; add all team members.
11. **ngrok** (or equivalent) for local webhook testing before deployment.

No payment is required for any of the above at hackathon scale.

---

## 5. Day-by-Day Build Order

| Day | Focus |
|---|---|
| **1** | Meta Developer setup (test number, webhook, "hello world" send/receive working). Supabase project + schema created. Repo scaffolded. |
| **1-2** | Baileys connected on dedicated number, logging live group messages to DB (get this number "aging" ASAP — see §6, it needs days of quiet activity before demo). |
| **2-3** | Embed-on-receipt pipeline: message arrives → chunk → embed → store, all synchronous, no batching. Hybrid retrieval working against real logged data. |
| **3** | Whisper transcription pipeline wired into same ingestion path, tested on a real call recording. |
| **4** | Answer Service: webhook → retrieval → LLM → reply, with citations and freshness/confidence gating. Test the "type something live, ask immediately" flow repeatedly. |
| **5** | Proactive features: digest job, duplicate-question detection, auto-recap after calls. |
| **6** | Polish: latency, edge cases, admin dashboard if time allows. Rehearse demo script on real prior questions. |
| **7** | Buffer for bugs. Write setup notes (submission requirement). Confirm Baileys number has been stable for several days. |

---

## 6. De-risking the Baileys Ingestion Listener

This is the one non-official piece — treat it carefully:

- **Dedicated number only**, never a personal one — spare SIM, eSIM, or VoIP number.
- **Connect it 3-4+ days before demo day**, not hours before. A number with several days of stable, low-volume, read-only activity is much less likely to be flagged than a freshly-paired one.
- **Read-only, always** — it must never send messages into the group. This is the single biggest lever for staying under detection thresholds (bans cluster around bulk/spam *sending* behavior).
- **Keep a backup number pre-paired**, ready to swap in if the primary gets flagged.
- If it does get banned: only ingestion is affected. The official Cloud API answering bot keeps working — judges never see it, you just temporarily stop capturing new messages until you swap numbers.

---

## 7. Handling the "Judge Types Live and Asks Immediately" Requirement

Since judges will test this directly, the pipeline must be **event-driven, not scheduled**:
- Baileys listener → embed-on-receipt (seconds, not batched on a cron) → immediately retrievable.
- Test this exact flow (type in group → DM the bot → ask about it) repeatedly before demo day to measure real latency and catch failures early.
- Freshness-gated answers (§3.4) as a safety net: if genuinely not yet indexed, the bot says so honestly rather than guessing — this reads as good engineering if it ever happens live, not as a bug.

---

## 8. What to Say If Judges Ask "Why This Architecture?"

- **"Why not fully live/unofficial for everything?"** → We didn't want the bot's ability to *answer* to depend on an unofficial connection that could be banned without warning — for something meant to be relied on daily, that's an unacceptable failure mode, so we split ingestion (accepts the risk, scoped and mitigated) from answering (zero risk, official API).
- **"Why not fully official?"** → The official API can't read existing group chats at all — there's no sanctioned way to do that, so live ingestion has to use a read-only unofficial listener; we minimized its risk profile by keeping it read-only and aging the number before deployment.
- **"How is this different from just asking ChatGPT to search our chat?"** → Unified across chat and calls, every answer cites its source (date + person), and it's proactive — it catches repeat questions and posts recaps without being asked, not just a search box.

---

## 9. Submission Checklist (per the brief)

- [ ] Working bot, live and testable (not a slide/mockup)
- [ ] GitHub repo access for the whole group
- [ ] Short setup/run/maintain notes in the repo README
- [ ] Team declaration already sent (name, members, countries) — due EOB Thu 17 Sept
- [ ] Ready for judging window: Fri 18 Sept – Thu 24 Sept

---

## 10. Stack Summary

- **WhatsApp answering**: WhatsApp Business Cloud API (official)
- **WhatsApp ingestion**: `@whiskeysockets/baileys` (Node.js), read-only
- **Transcription**: Whisper (API or local)
- **Backend**: Node.js or Python service, always-on (hosted on Railway/Render/Fly.io)
- **DB**: Supabase (Postgres + pgvector)
- **LLM**: Claude or GPT for answer generation
- **Embeddings**: OpenAI `text-embedding-3-small` / Voyage / local `bge-small`
- **Scheduler**: `node-cron` (or equivalent) for digest jobs
- **Optional dashboard**: Next.js
