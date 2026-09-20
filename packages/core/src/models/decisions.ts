import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Decision, DecisionStatus, MemoryRelations, NewDecision } from './types.js';

interface DecisionRow {
  id: string;
  project_id: string;
  title: string;
  status: DecisionStatus;
  reason: string;
  notes: string;
  parent_decision_id: string | null;
  replacement_decision_id: string | null;
  checkpoint_id: string | null;
  temporary: number;
  revisit_condition: string;
  revisit_date: string | null;
  review_status: Decision['reviewStatus'];
  created_at: string;
  updated_at: string;
}

function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    reason: row.reason,
    notes: row.notes,
    parentDecisionId: row.parent_decision_id,
    replacementDecisionId: row.replacement_decision_id,
    checkpointId: row.checkpoint_id,
    temporary: row.temporary === 1,
    revisitCondition: row.revisit_condition,
    revisitDate: row.revisit_date,
    reviewStatus: row.review_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDecision(db: Database.Database, input: NewDecision): Decision {
  const id = randomUUID();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO decisions (
         id, project_id, title, status, reason, notes,
         parent_decision_id, replacement_decision_id, checkpoint_id,
         temporary, revisit_condition, revisit_date, review_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      input.title,
      input.status ?? 'active',
      input.reason ?? '',
      input.notes ?? '',
      input.parentDecisionId ?? null,
      input.replacementDecisionId ?? null,
      input.checkpointId ?? null,
      input.temporary ? 1 : 0,
      input.revisitCondition ?? '',
      input.revisitDate ?? null,
      input.reviewStatus ?? 'pending'
    );
    setDecisionRelations(db, id, input.projectId, input);
  });
  tx();
  return getDecisionById(db, id)!;
}

export function getDecisionById(db: Database.Database, id: string): Decision | null {
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as DecisionRow | undefined;
  return row ? toDecision(row) : null;
}

export function listDecisionsForProject(db: Database.Database, projectId: string): Decision[] {
  const rows = db.prepare(
    `SELECT * FROM decisions WHERE project_id = ?
     ORDER BY created_at ASC, rowid ASC`
  ).all(projectId) as DecisionRow[];
  return rows.map(toDecision);
}

export function updateDecision(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<Decision, 'title' | 'status' | 'reason' | 'notes' | 'parentDecisionId' | 'replacementDecisionId' | 'checkpointId' | 'temporary' | 'revisitCondition' | 'revisitDate' | 'reviewStatus'>>
): Decision | null {
  const current = getDecisionById(db, id);
  if (!current) return null;
  db.prepare(
    `UPDATE decisions SET title = ?, status = ?, reason = ?, notes = ?,
       parent_decision_id = ?, replacement_decision_id = ?, checkpoint_id = ?,
       temporary = ?, revisit_condition = ?, revisit_date = ?, review_status = ?,
       updated_at = datetime('now') WHERE id = ?`
  ).run(
    patch.title ?? current.title,
    patch.status ?? current.status,
    patch.reason ?? current.reason,
    patch.notes ?? current.notes,
    patch.parentDecisionId === undefined ? current.parentDecisionId : patch.parentDecisionId,
    patch.replacementDecisionId === undefined ? current.replacementDecisionId : patch.replacementDecisionId,
    patch.checkpointId === undefined ? current.checkpointId : patch.checkpointId,
    patch.temporary === undefined ? (current.temporary ? 1 : 0) : (patch.temporary ? 1 : 0),
    patch.revisitCondition ?? current.revisitCondition,
    patch.revisitDate === undefined ? current.revisitDate : patch.revisitDate,
    patch.reviewStatus ?? current.reviewStatus,
    id
  );
  return getDecisionById(db, id);
}

export function setDecisionRelations(
  db: Database.Database,
  decisionId: string,
  projectId: string,
  relations: Partial<MemoryRelations>
): void {
  const unique = (values: string[] | undefined) =>
    [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
  const specs = [
    ['decision_commits', 'commit_hash', relations.commitHashes],
    ['decision_files', 'file_path', relations.filePaths],
    ['decision_entries', 'entry_id', relations.entryIds],
    ['decision_research', 'research_id', relations.researchIds],
    ['decision_assumptions', 'assumption_id', relations.assumptionIds],
  ] as const;
  for (const [table, column, rawValues] of specs) {
    if (rawValues === undefined) continue;
    const values = unique(rawValues);
    db.prepare(`DELETE FROM ${table} WHERE decision_id = ?`).run(decisionId);
    for (const value of values) {
      if (table === 'decision_commits') {
        db.prepare(
          'INSERT INTO decision_commits (decision_id, commit_hash, project_id) VALUES (?, ?, ?)'
        ).run(decisionId, value, projectId);
      } else {
        db.prepare(`INSERT INTO ${table} (decision_id, ${column}) VALUES (?, ?)`)
          .run(decisionId, value);
      }
    }
  }
}

export function getDecisionRelations(db: Database.Database, decisionId: string): MemoryRelations {
  const values = (table: string, column: string): string[] =>
    (db.prepare(`SELECT ${column} AS value FROM ${table} WHERE decision_id = ? ORDER BY ${column}`)
      .all(decisionId) as { value: string }[]).map((row) => row.value);
  return {
    commitHashes: values('decision_commits', 'commit_hash'),
    filePaths: values('decision_files', 'file_path'),
    entryIds: values('decision_entries', 'entry_id'),
    researchIds: values('decision_research', 'research_id'),
    assumptionIds: values('decision_assumptions', 'assumption_id'),
  };
}

export function deleteDecision(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM decisions WHERE id = ?').run(id);
}
