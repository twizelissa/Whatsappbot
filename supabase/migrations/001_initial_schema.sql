-- ============================================================
-- UniPods WhatsApp Bot — Database Schema
-- Run on a Supabase project (Postgres + pgvector)
-- ============================================================

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- for keyword search

-- ── Messages table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender       TEXT NOT NULL,                -- WhatsApp JID or phone
  sender_name  TEXT NOT NULL DEFAULT '',     -- display name
  timestamp    TIMESTAMPTZ NOT NULL,
  text         TEXT,
  source       TEXT NOT NULL CHECK (source IN ('whatsapp', 'call_transcript')),
  media_url    TEXT,
  media_type   TEXT,
  reply_to     TEXT,
  group_id     TEXT NOT NULL DEFAULT '',
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages (timestamp DESC);
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (sender);
CREATE INDEX IF NOT EXISTS messages_group_id_idx ON messages (group_id);
CREATE INDEX IF NOT EXISTS messages_source_idx ON messages (source);

-- ── Transcripts table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transcripts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id      TEXT NOT NULL,              -- identifier for the call session
  timestamp    FLOAT NOT NULL,            -- seconds from call start
  speaker      TEXT,                      -- speaker label (if diarized)
  text         TEXT NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transcripts_call_id_idx ON transcripts (call_id);
CREATE INDEX IF NOT EXISTS transcripts_timestamp_idx ON transcripts (timestamp);

-- ── Chunks table (vector store) ───────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    UUID NOT NULL,             -- FK to messages.id or transcripts.id
  source_type  TEXT NOT NULL CHECK (source_type IN ('message', 'transcript')),
  text         TEXT NOT NULL,
  embedding    vector(1536),              -- OpenAI text-embedding-3-small (1536 dims)
                                          -- Change to 768 for bge-small
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vector similarity index (IVFFlat for cosine distance)
-- Adjust lists based on dataset size: ~sqrt(row count) but min 10
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Full-text search index
CREATE INDEX IF NOT EXISTS chunks_text_fts_idx
  ON chunks USING gin (to_tsvector('english', text));

-- Trigram index for fuzzy keyword search
CREATE INDEX IF NOT EXISTS chunks_text_trgm_idx
  ON chunks USING gin (text gin_trgm_ops);

-- Metadata index for filtering
CREATE INDEX IF NOT EXISTS chunks_metadata_idx ON chunks USING gin (metadata);
CREATE INDEX IF NOT EXISTS chunks_source_type_idx ON chunks (source_type);

-- ── Bot answers log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS answers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  user_phone      TEXT NOT NULL,
  user_name       TEXT,
  confidence      TEXT NOT NULL,
  is_duplicate    BOOLEAN NOT NULL DEFAULT FALSE,
  sources         JSONB NOT NULL DEFAULT '[]',
  chunk_ids       UUID[] DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS answers_created_at_idx ON answers (created_at DESC);
CREATE INDEX IF NOT EXISTS answers_user_phone_idx ON answers (user_phone);

-- ── Digests log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS digests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start TIMESTAMPTZ NOT NULL,
  period_end   TIMESTAMPTZ NOT NULL,
  digest_type  TEXT NOT NULL DEFAULT 'daily',  -- 'daily', 'weekly', 'call_recap'
  call_id      TEXT,                            -- for call recaps
  content      TEXT NOT NULL,
  sent_to      TEXT[],                          -- phone numbers it was sent to
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Row-level security (RLS) ──────────────────────────────────
-- Disable RLS for service role (our backend uses service key)
ALTER TABLE messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts DISABLE ROW LEVEL SECURITY;
ALTER TABLE chunks DISABLE ROW LEVEL SECURITY;
ALTER TABLE answers DISABLE ROW LEVEL SECURITY;
ALTER TABLE digests DISABLE ROW LEVEL SECURITY;
