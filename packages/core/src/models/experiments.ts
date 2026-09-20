import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Experiment, ExperimentStatus, NewExperiment } from './types.js';

interface ExperimentRow {
  id: string; project_id: string; title: string; hypothesis: string; tested: string;
  method: string; result: string; conclusion: string; status: ExperimentStatus;
  experiment_date: string; resulting_decision_id: string | null; notes: string;
  created_at: string; updated_at: string;
}

function relations(db: Database.Database, id: string) {
  const values = (table: string, column: string) => (db.prepare(
    `SELECT ${column} value FROM ${table} WHERE experiment_id=? ORDER BY ${column}`
  ).all(id) as { value: string }[]).map((row) => row.value);
  return {
    commitHashes: values('experiment_commits', 'commit_hash'),
    filePaths: values('experiment_files', 'file_path'),
    entryIds: values('experiment_entries', 'entry_id'),
    researchIds: values('experiment_research', 'research_id'),
    assumptionIds: values('experiment_assumptions', 'assumption_id'),
  };
}

function fromRow(db: Database.Database, row: ExperimentRow): Experiment {
  return {
    id: row.id, projectId: row.project_id, title: row.title, hypothesis: row.hypothesis,
    tested: row.tested, method: row.method, result: row.result, conclusion: row.conclusion,
    status: row.status, experimentDate: row.experiment_date,
    resultingDecisionId: row.resulting_decision_id, notes: row.notes,
    createdAt: row.created_at, updatedAt: row.updated_at, ...relations(db, row.id),
  };
}

function setRelations(db: Database.Database, id: string, projectId: string, input: NewExperiment) {
  const specs = [
    ['experiment_commits', 'commit_hash', input.commitHashes],
    ['experiment_files', 'file_path', input.filePaths],
    ['experiment_entries', 'entry_id', input.entryIds],
    ['experiment_research', 'research_id', input.researchIds],
    ['experiment_assumptions', 'assumption_id', input.assumptionIds],
  ] as const;
  for (const [table, column, raw] of specs) {
    for (const value of [...new Set((raw ?? []).map((item) => item.trim()).filter(Boolean))]) {
      if (table === 'experiment_commits') {
        db.prepare(`INSERT OR IGNORE INTO ${table}(experiment_id,${column},project_id) VALUES(?,?,?)`).run(id, value, projectId);
      } else {
        db.prepare(`INSERT OR IGNORE INTO ${table}(experiment_id,${column}) VALUES(?,?)`).run(id, value);
      }
    }
  }
}

export function createExperiment(db: Database.Database, input: NewExperiment): Experiment {
  const id = randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO experiments(id,project_id,title,hypothesis,tested,method,result,conclusion,status,experiment_date,resulting_decision_id,notes)
       VALUES(?,?,?,?,?,?,?,?,?,COALESCE(?,date('now')),?,?)`
    ).run(id, input.projectId, input.title, input.hypothesis ?? '', input.tested ?? '', input.method ?? '', input.result ?? '', input.conclusion ?? '', input.status ?? 'planned', input.experimentDate ?? null, input.resultingDecisionId ?? null, input.notes ?? '');
    setRelations(db, id, input.projectId, input);
  })();
  return getExperimentById(db, id)!;
}

export function getExperimentById(db: Database.Database, id: string): Experiment | null {
  const row = db.prepare('SELECT * FROM experiments WHERE id=?').get(id) as ExperimentRow | undefined;
  return row ? fromRow(db, row) : null;
}

export function listExperimentsForProject(db: Database.Database, projectId: string): Experiment[] {
  return (db.prepare('SELECT * FROM experiments WHERE project_id=? ORDER BY experiment_date DESC,created_at DESC,rowid DESC').all(projectId) as ExperimentRow[]).map((row) => fromRow(db, row));
}

export function deleteExperiment(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM experiments WHERE id=?').run(id);
}

