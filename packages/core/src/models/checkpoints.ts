import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Checkpoint, MemoryRelations, NewCheckpoint } from './types.js';

interface CheckpointRow {
  id: string;
  project_id: string;
  title: string;
  note: string;
  working_on: string;
  current_works: string;
  broken_or_unfinished: string;
  trying_to_understand: string;
  decisions_made: string;
  alternatives_rejected: string;
  open_questions: string;
  next_step: string;
  created_at: string;
}

function toCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    note: row.note,
    workingOn: row.working_on,
    currentWorks: row.current_works,
    brokenOrUnfinished: row.broken_or_unfinished,
    tryingToUnderstand: row.trying_to_understand,
    decisionsMade: row.decisions_made,
    alternativesRejected: row.alternatives_rejected,
    openQuestions: row.open_questions,
    nextStep: row.next_step,
    createdAt: row.created_at,
  };
}

export function createCheckpoint(db: Database.Database, input: NewCheckpoint): Checkpoint {
  const id = randomUUID();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO checkpoints (
         id, project_id, title, note, working_on, current_works,
         broken_or_unfinished, trying_to_understand, decisions_made,
         alternatives_rejected, open_questions, next_step
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.projectId,
      input.title,
      input.note ?? '',
      input.workingOn ?? '',
      input.currentWorks ?? '',
      input.brokenOrUnfinished ?? '',
      input.tryingToUnderstand ?? '',
      input.decisionsMade ?? '',
      input.alternativesRejected ?? '',
      input.openQuestions ?? '',
      input.nextStep ?? ''
    );

    for (const hash of input.commitHashes ?? []) {
      db.prepare(
        `INSERT OR IGNORE INTO checkpoint_commits (checkpoint_id, project_id, commit_hash)
         VALUES (?, ?, ?)`
      ).run(id, input.projectId, hash);
    }
    for (const filePath of input.filePaths ?? []) {
      if (filePath.trim()) {
        db.prepare('INSERT OR IGNORE INTO checkpoint_files (checkpoint_id, file_path) VALUES (?, ?)')
          .run(id, filePath.trim());
      }
    }
    for (const entryId of input.entryIds ?? []) {
      if (entryId.trim()) {
        db.prepare('INSERT OR IGNORE INTO checkpoint_entries (checkpoint_id, entry_id) VALUES (?, ?)')
          .run(id, entryId.trim());
      }
    }
    for (const researchId of input.researchIds ?? []) {
      if (researchId.trim()) {
        db.prepare('INSERT OR IGNORE INTO checkpoint_research (checkpoint_id, research_id) VALUES (?, ?)')
          .run(id, researchId.trim());
      }
    }
  });
  tx();
  return getCheckpointById(db, id)!;
}

export function getCheckpointById(db: Database.Database, id: string): Checkpoint | null {
  const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as
    | CheckpointRow
    | undefined;
  return row ? toCheckpoint(row) : null;
}

export function listCheckpointsForProject(
  db: Database.Database,
  projectId: string
): Checkpoint[] {
  const rows = db
    .prepare('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(projectId) as CheckpointRow[];
  return rows.map(toCheckpoint);
}

export function getCommitsForCheckpoint(db: Database.Database, checkpointId: string): string[] {
  const rows = db
    .prepare('SELECT commit_hash FROM checkpoint_commits WHERE checkpoint_id = ?')
    .all(checkpointId) as { commit_hash: string }[];
  return rows.map((r) => r.commit_hash);
}

export function getCheckpointRelations(
  db: Database.Database,
  checkpointId: string
): MemoryRelations {
  const values = (table: string, column: string): string[] =>
    (db.prepare(`SELECT ${column} AS value FROM ${table} WHERE checkpoint_id = ? ORDER BY ${column}`)
      .all(checkpointId) as { value: string }[]).map((row) => row.value);
  return {
    commitHashes: values('checkpoint_commits', 'commit_hash'),
    filePaths: values('checkpoint_files', 'file_path'),
    entryIds: values('checkpoint_entries', 'entry_id'),
    researchIds: values('checkpoint_research', 'research_id'),
  };
}

export function attachToCheckpoint(
  db: Database.Database,
  checkpointId: string,
  attachmentId: string
): void {
  db.prepare(
    `INSERT OR IGNORE INTO checkpoint_attachments (checkpoint_id, attachment_id) VALUES (?, ?)`
  ).run(checkpointId, attachmentId);
}

export function deleteCheckpoint(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM checkpoints WHERE id = ?').run(id);
}
