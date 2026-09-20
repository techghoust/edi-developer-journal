PRAGMA foreign_keys = ON;

ALTER TABLE projects ADD COLUMN last_checked_at TEXT;
ALTER TABLE projects ADD COLUMN last_head_hash TEXT;
ALTER TABLE projects ADD COLUMN last_working_tree_clean INTEGER NOT NULL DEFAULT 1;
