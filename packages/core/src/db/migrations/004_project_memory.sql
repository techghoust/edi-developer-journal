ALTER TABLE checkpoints ADD COLUMN working_on TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN current_works TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN broken_or_unfinished TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN trying_to_understand TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN decisions_made TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN alternatives_rejected TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN open_questions TEXT NOT NULL DEFAULT '';
ALTER TABLE checkpoints ADD COLUMN next_step TEXT NOT NULL DEFAULT '';

ALTER TABLE projects ADD COLUMN last_changed_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN last_untracked_files INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS checkpoint_files (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  PRIMARY KEY (checkpoint_id, file_path)
);

CREATE TABLE IF NOT EXISTS checkpoint_entries (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  entry_id       TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  PRIMARY KEY (checkpoint_id, entry_id)
);

CREATE TABLE IF NOT EXISTS checkpoint_research (
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  research_id    TEXT NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
  PRIMARY KEY (checkpoint_id, research_id)
);

CREATE TABLE IF NOT EXISTS decisions (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                   TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'superseded', 'rejected', 'experimental')),
  reason                  TEXT NOT NULL DEFAULT '',
  notes                   TEXT NOT NULL DEFAULT '',
  parent_decision_id      TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  replacement_decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  checkpoint_id           TEXT REFERENCES checkpoints(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_parent ON decisions(parent_decision_id);

CREATE TABLE IF NOT EXISTS decision_commits (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  commit_hash TEXT NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, commit_hash)
);

CREATE TABLE IF NOT EXISTS decision_files (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  PRIMARY KEY (decision_id, file_path)
);

CREATE TABLE IF NOT EXISTS decision_entries (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, entry_id)
);

CREATE TABLE IF NOT EXISTS decision_research (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  research_id TEXT NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, research_id)
);

CREATE VIEW IF NOT EXISTS project_memory_timeline AS
SELECT id, project_id, 'journal' AS kind, title, created_at AS occurred_at FROM entries
UNION ALL
SELECT id, project_id, 'checkpoint' AS kind, title, created_at AS occurred_at FROM checkpoints
UNION ALL
SELECT id, project_id, 'decision' AS kind, title, created_at AS occurred_at FROM decisions
UNION ALL
SELECT id, project_id, 'research' AS kind, title, created_at AS occurred_at FROM research_items;
