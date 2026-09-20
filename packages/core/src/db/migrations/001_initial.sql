PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  git_remote  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body_md     TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL CHECK (source IN ('manual', 'auto')) DEFAULT 'manual',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_id);

CREATE TABLE IF NOT EXISTS tags (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS entry_tags (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, tag_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT REFERENCES entries(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('image', 'file', 'link')),
  path_or_url  TEXT NOT NULL,
  caption      TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_entry ON attachments(entry_id);

CREATE TABLE IF NOT EXISTS commits_cache (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hash        TEXT NOT NULL,
  message     TEXT NOT NULL,
  author      TEXT NOT NULL,
  date        TEXT NOT NULL,
  UNIQUE (project_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_commits_project ON commits_cache(project_id);

CREATE TABLE IF NOT EXISTS entry_commits (
  entry_id     TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  commit_hash  TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, commit_hash)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_id);

CREATE TABLE IF NOT EXISTS checkpoint_commits (
  checkpoint_id  TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  commit_hash    TEXT NOT NULL,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (checkpoint_id, commit_hash)
);

CREATE TABLE IF NOT EXISTS checkpoint_attachments (
  checkpoint_id   TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  attachment_id   TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (checkpoint_id, attachment_id)
);

CREATE TABLE IF NOT EXISTS research_items (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('pdf', 'link', 'image', 'video', 'note')),
  title       TEXT NOT NULL,
  path_or_url TEXT,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_research_project ON research_items(project_id);

CREATE TABLE IF NOT EXISTS research_links (
  research_id  TEXT NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
  entry_id     TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  PRIMARY KEY (research_id, entry_id)
);

CREATE TABLE IF NOT EXISTS timeline_items (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('idea', 'research', 'prototype', 'architecture', 'refactor', 'release')),
  entry_id    TEXT REFERENCES entries(id) ON DELETE SET NULL,
  date        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timeline_project ON timeline_items(project_id);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  title, body_md, content='entries', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;

CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
END;

CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
  INSERT INTO entries_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
