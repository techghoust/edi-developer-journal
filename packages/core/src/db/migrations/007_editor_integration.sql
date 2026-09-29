CREATE TABLE IF NOT EXISTS integration_sources (
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_kind             TEXT NOT NULL CHECK (memory_kind IN ('note', 'decision', 'experiment', 'research')),
  memory_id               TEXT NOT NULL,
  client_id               TEXT NOT NULL,
  client_version          TEXT NOT NULL,
  file_path               TEXT,
  workspace_relative_path TEXT,
  language_id             TEXT,
  start_line              INTEGER CHECK (start_line IS NULL OR start_line >= 0),
  start_character         INTEGER CHECK (start_character IS NULL OR start_character >= 0),
  end_line                INTEGER CHECK (end_line IS NULL OR end_line >= 0),
  end_character           INTEGER CHECK (end_character IS NULL OR end_character >= 0),
  selected_text           TEXT,
  branch                  TEXT,
  head_commit             TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, memory_kind, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_sources_file
  ON integration_sources(project_id, workspace_relative_path, file_path);

CREATE TABLE IF NOT EXISTS integration_requests (
  request_id     TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  client_version TEXT NOT NULL,
  action         TEXT NOT NULL,
  response_json  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_integration_requests_created
  ON integration_requests(created_at);
