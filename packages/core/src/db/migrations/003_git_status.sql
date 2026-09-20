ALTER TABLE projects ADD COLUMN git_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (git_status IN ('unknown', 'ok', 'not-repository', 'unavailable'));
