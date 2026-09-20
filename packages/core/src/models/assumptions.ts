import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Assumption, AssumptionStatus, NewAssumption } from './types.js';

interface AssumptionRow {
  id: string;
  project_id: string;
  statement: string;
  status: AssumptionStatus;
  notes: string;
  created_at: string;
  invalidated_at: string | null;
}

function fromRow(row: AssumptionRow): Assumption {
  return {
    id: row.id,
    projectId: row.project_id,
    statement: row.statement,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    invalidatedAt: row.invalidated_at,
  };
}

export function createAssumption(db: Database.Database, input: NewAssumption): Assumption {
  const id = randomUUID();
  const status = input.status ?? 'active';
  db.prepare(
    `INSERT INTO assumptions(id,project_id,statement,status,notes,invalidated_at)
     VALUES(?,?,?,?,?,CASE WHEN ?='invalidated' THEN datetime('now') ELSE NULL END)`
  ).run(id, input.projectId, input.statement, status, input.notes ?? '', status);
  return getAssumptionById(db, id)!;
}

export function getAssumptionById(db: Database.Database, id: string): Assumption | null {
  const row = db.prepare('SELECT * FROM assumptions WHERE id=?').get(id) as AssumptionRow | undefined;
  return row ? fromRow(row) : null;
}

export function listAssumptionsForProject(db: Database.Database, projectId: string): Assumption[] {
  return (db.prepare('SELECT * FROM assumptions WHERE project_id=? ORDER BY created_at ASC,rowid ASC').all(projectId) as AssumptionRow[]).map(fromRow);
}

export function updateAssumption(db: Database.Database, id: string, status: AssumptionStatus, notes?: string): Assumption | null {
  db.prepare(
    `UPDATE assumptions SET status=?, notes=COALESCE(?,notes),
     invalidated_at=CASE WHEN ?='invalidated' THEN COALESCE(invalidated_at,datetime('now')) ELSE NULL END
     WHERE id=?`
  ).run(status, notes ?? null, status, id);
  return getAssumptionById(db, id);
}

