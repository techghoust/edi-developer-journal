CREATE TABLE IF NOT EXISTS assumptions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  statement      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'questioned', 'invalidated')),
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  invalidated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assumptions_project ON assumptions(project_id, created_at);

CREATE TABLE IF NOT EXISTS experiments (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  hypothesis            TEXT NOT NULL DEFAULT '',
  tested                TEXT NOT NULL DEFAULT '',
  method                TEXT NOT NULL DEFAULT '',
  result                TEXT NOT NULL DEFAULT '',
  conclusion            TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'planned'
                          CHECK (status IN ('planned', 'running', 'successful', 'failed', 'inconclusive', 'abandoned')),
  experiment_date       TEXT NOT NULL DEFAULT (date('now')),
  resulting_decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
  notes                 TEXT NOT NULL DEFAULT '',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_experiments_project ON experiments(project_id, created_at);

CREATE TABLE IF NOT EXISTS experiment_commits (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  commit_hash   TEXT NOT NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (experiment_id, commit_hash)
);
CREATE TABLE IF NOT EXISTS experiment_files (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  PRIMARY KEY (experiment_id, file_path)
);
CREATE TABLE IF NOT EXISTS experiment_entries (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  entry_id      TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  PRIMARY KEY (experiment_id, entry_id)
);
CREATE TABLE IF NOT EXISTS experiment_research (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  research_id   TEXT NOT NULL REFERENCES research_items(id) ON DELETE CASCADE,
  PRIMARY KEY (experiment_id, research_id)
);
CREATE TABLE IF NOT EXISTS experiment_assumptions (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  assumption_id TEXT NOT NULL REFERENCES assumptions(id) ON DELETE CASCADE,
  PRIMARY KEY (experiment_id, assumption_id)
);
CREATE TABLE IF NOT EXISTS decision_assumptions (
  decision_id   TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  assumption_id TEXT NOT NULL REFERENCES assumptions(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, assumption_id)
);

ALTER TABLE decisions ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0;
ALTER TABLE decisions ADD COLUMN revisit_condition TEXT NOT NULL DEFAULT '';
ALTER TABLE decisions ADD COLUMN revisit_date TEXT;
ALTER TABLE decisions ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (review_status IN ('pending', 'reviewed', 'dismissed'));

DROP VIEW IF EXISTS project_memory_timeline;
CREATE VIEW project_memory_timeline AS
SELECT id, project_id, 'journal' AS kind, title, created_at AS occurred_at FROM entries
UNION ALL
SELECT id, project_id, 'checkpoint' AS kind, title, created_at AS occurred_at FROM checkpoints
UNION ALL
SELECT id, project_id, 'decision' AS kind, title, created_at AS occurred_at FROM decisions
UNION ALL
SELECT id, project_id, 'research' AS kind, title, created_at AS occurred_at FROM research_items
UNION ALL
SELECT id, project_id, 'experiment' AS kind, title, created_at AS occurred_at FROM experiments
UNION ALL
SELECT id, project_id, 'assumption' AS kind, statement AS title, created_at AS occurred_at FROM assumptions;

ALTER TABLE xray_memory_links RENAME TO xray_memory_links_before_engineering_memory;
CREATE TABLE xray_memory_links (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dependency_name TEXT NOT NULL,
  memory_kind     TEXT NOT NULL CHECK (memory_kind IN ('journal', 'checkpoint', 'decision', 'research', 'experiment', 'assumption')),
  memory_id       TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, dependency_name, memory_kind, memory_id)
);
INSERT INTO xray_memory_links(project_id, dependency_name, memory_kind, memory_id, created_at)
SELECT project_id, dependency_name, memory_kind, memory_id, created_at
FROM xray_memory_links_before_engineering_memory;
DROP TABLE xray_memory_links_before_engineering_memory;
CREATE INDEX IF NOT EXISTS idx_xray_memory_dependency
  ON xray_memory_links(project_id, dependency_name);

CREATE VIEW IF NOT EXISTS failure_memory AS
SELECT id, project_id, 'experiment' AS kind, title,
       status, conclusion AS reason, updated_at AS occurred_at
FROM experiments WHERE status IN ('failed', 'inconclusive', 'abandoned')
UNION ALL
SELECT id, project_id, 'decision' AS kind, title,
       status, reason, updated_at AS occurred_at
FROM decisions WHERE status IN ('superseded', 'rejected');

CREATE VIEW IF NOT EXISTS decision_debt AS
SELECT id, project_id, title, status, revisit_condition, revisit_date,
       review_status, created_at,
       CASE WHEN revisit_date IS NOT NULL AND date(revisit_date) <= date('now') THEN 1 ELSE 0 END AS overdue
FROM decisions
WHERE temporary = 1 AND status = 'active' AND review_status = 'pending';

CREATE VIEW IF NOT EXISTS explicit_memory_conflicts AS
SELECT d.project_id, 'decision' AS memory_kind, d.id AS memory_id, d.title,
       a.id AS assumption_id, a.statement, a.status
FROM decisions d
JOIN decision_assumptions da ON da.decision_id = d.id
JOIN assumptions a ON a.id = da.assumption_id
WHERE a.status IN ('questioned', 'invalidated')
UNION ALL
SELECT e.project_id, 'experiment' AS memory_kind, e.id AS memory_id, e.title,
       a.id AS assumption_id, a.statement, a.status
FROM experiments e
JOIN experiment_assumptions ea ON ea.experiment_id = e.id
JOIN assumptions a ON a.id = ea.assumption_id
WHERE a.status IN ('questioned', 'invalidated');

CREATE VIEW IF NOT EXISTS edi_memory_relationships AS
SELECT d.project_id, 'decision' AS source_kind, d.id AS source_id,
       'decision' AS target_kind, d.parent_decision_id AS target_id, 'evolves-from' AS relation
FROM decisions d WHERE d.parent_decision_id IS NOT NULL
UNION ALL
SELECT e.project_id, 'decision', e.resulting_decision_id, 'experiment', e.id, 'resulted-from'
FROM experiments e WHERE e.resulting_decision_id IS NOT NULL
UNION ALL
SELECT er.project_id, 'experiment', er.id, 'research', r.research_id, 'based-on'
FROM experiments er JOIN experiment_research r ON r.experiment_id = er.id
UNION ALL
SELECT e.project_id, 'experiment', e.id, 'assumption', a.assumption_id, 'assumes'
FROM experiments e JOIN experiment_assumptions a ON a.experiment_id = e.id
UNION ALL
SELECT e.project_id, 'experiment', e.id, 'journal', n.entry_id, 'documented-by'
FROM experiments e JOIN experiment_entries n ON n.experiment_id = e.id
UNION ALL
SELECT d.project_id, 'decision', d.id, 'research', r.research_id, 'based-on'
FROM decisions d JOIN decision_research r ON r.decision_id = d.id
UNION ALL
SELECT d.project_id, 'decision', d.id, 'assumption', a.assumption_id, 'assumes'
FROM decisions d JOIN decision_assumptions a ON a.decision_id = d.id
UNION ALL
SELECT x.project_id, 'dependency', x.dependency_name, x.memory_kind, x.memory_id, 'explained-by'
FROM xray_memory_links x;
