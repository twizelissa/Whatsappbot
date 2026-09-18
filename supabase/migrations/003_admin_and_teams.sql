-- ============================================================
-- Migration 003: Admin flag on messages + Teams call_source
-- ============================================================

-- Add is_admin column to messages table
-- TRUE if the sender was a group admin at the time the message was sent
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS messages_is_admin_idx ON messages (is_admin)
  WHERE is_admin = TRUE;

-- Add call_source to transcripts so we know which platform recorded the call
-- Values: 'teams', 'manual_upload', 'zoom', etc.
ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS call_source TEXT NOT NULL DEFAULT 'teams';

CREATE INDEX IF NOT EXISTS transcripts_call_source_idx ON transcripts (call_source);

-- Propagate is_admin into the chunk metadata index for fast admin-only filtering
-- (The actual is_admin value is stored in chunks.metadata->>'is_admin' as JSON)
CREATE INDEX IF NOT EXISTS chunks_admin_idx
  ON chunks ((metadata->>'is_admin'))
  WHERE metadata->>'is_admin' = 'true';
