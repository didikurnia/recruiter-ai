-- Grammy session persistence table
-- Stores serialized SessionData (language, FSM state) keyed by chat_id
CREATE TABLE IF NOT EXISTS bot_sessions (
  key        TEXT        PRIMARY KEY,
  data       JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_updated_at ON bot_sessions (updated_at);

-- Mastra session/memory tables are created automatically by PostgresStore.init()
-- Tables managed by Mastra (@mastra/pg):
--   mastra_threads          — conversation threads per candidate (chat_id as resourceId)
--   mastra_messages         — individual messages per thread
--   mastra_resources        — shared memory resources
--   mastra_observational_memory — agent observational memory

-- PgVector index tables (e.g. job_embeddings) are created on first createIndex() call
-- in Story 2.x (RAG ingestion pipeline).
