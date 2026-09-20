CREATE TABLE IF NOT EXISTS xray_memory_links (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dependency_name TEXT NOT NULL,
  memory_kind     TEXT NOT NULL CHECK (memory_kind IN ('journal', 'checkpoint', 'decision', 'research')),
  memory_id       TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, dependency_name, memory_kind, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_xray_memory_dependency
  ON xray_memory_links(project_id, dependency_name);
