-- ============================================================
-- Migration 004: Switch embedding dimensions to 768
-- Required for Gemini text-embedding-004 (768 dims)
-- Run ONLY if you haven't stored any embeddings yet,
-- or if you're starting fresh.
-- ============================================================

-- Drop the vector index first (can't alter column with an index)
DROP INDEX IF EXISTS chunks_embedding_idx;

-- Alter the embedding column to 768 dimensions
ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(768);

-- Recreate the vector similarity index
CREATE INDEX chunks_embedding_idx
  ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
