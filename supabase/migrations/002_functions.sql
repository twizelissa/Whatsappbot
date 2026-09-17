-- ============================================================
-- Useful SQL functions for the application
-- ============================================================

-- Hybrid search function (vector + keyword combined)
CREATE OR REPLACE FUNCTION hybrid_search(
  query_embedding vector(1536),
  query_text      TEXT,
  match_count     INT DEFAULT 10,
  filter_group_id TEXT DEFAULT NULL,
  filter_source   TEXT DEFAULT NULL
)
RETURNS TABLE (
  id          UUID,
  source_id   UUID,
  source_type TEXT,
  text        TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ,
  similarity  FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT
      c.id, c.source_id, c.source_type, c.text, c.metadata, c.created_at,
      1 - (c.embedding <=> query_embedding) AS vsim,
      ROW_NUMBER() OVER (ORDER BY c.embedding <=> query_embedding) AS vrank
    FROM chunks c
    WHERE c.embedding IS NOT NULL
      AND (filter_group_id IS NULL OR c.metadata->>'group_id' = filter_group_id)
      AND (filter_source IS NULL OR c.source_type = filter_source)
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count * 2
  ),
  keyword_results AS (
    SELECT
      c.id, c.source_id, c.source_type, c.text, c.metadata, c.created_at,
      ts_rank_cd(to_tsvector('english', c.text), plainto_tsquery('english', query_text)) AS ksim,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(to_tsvector('english', c.text), plainto_tsquery('english', query_text)) DESC) AS krank
    FROM chunks c
    WHERE to_tsvector('english', c.text) @@ plainto_tsquery('english', query_text)
      AND (filter_group_id IS NULL OR c.metadata->>'group_id' = filter_group_id)
      AND (filter_source IS NULL OR c.source_type = filter_source)
    LIMIT match_count * 2
  ),
  rrf AS (
    SELECT
      COALESCE(v.id, k.id) AS id,
      COALESCE(v.source_id, k.source_id) AS source_id,
      COALESCE(v.source_type, k.source_type) AS source_type,
      COALESCE(v.text, k.text) AS text,
      COALESCE(v.metadata, k.metadata) AS metadata,
      COALESCE(v.created_at, k.created_at) AS created_at,
      COALESCE(1.0 / (60 + v.vrank), 0) + COALESCE(1.0 / (60 + k.krank), 0) AS rrf_score
    FROM vector_results v
    FULL OUTER JOIN keyword_results k ON v.id = k.id
  )
  SELECT
    r.id, r.source_id, r.source_type, r.text, r.metadata, r.created_at,
    r.rrf_score AS similarity
  FROM rrf r
  ORDER BY r.rrf_score DESC
  LIMIT match_count;
END;
$$;

-- Get stats for dashboard
CREATE OR REPLACE FUNCTION get_bot_stats()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'total_messages', (SELECT COUNT(*) FROM messages),
    'total_chunks', (SELECT COUNT(*) FROM chunks),
    'embedded_chunks', (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL),
    'total_transcripts', (SELECT COUNT(*) FROM transcripts),
    'total_answers', (SELECT COUNT(*) FROM answers),
    'last_message_at', (SELECT MAX(timestamp) FROM messages),
    'messages_today', (SELECT COUNT(*) FROM messages WHERE timestamp >= NOW() - INTERVAL '24 hours'),
    'answers_today', (SELECT COUNT(*) FROM answers WHERE created_at >= NOW() - INTERVAL '24 hours')
  ) INTO result;
  RETURN result;
END;
$$;
