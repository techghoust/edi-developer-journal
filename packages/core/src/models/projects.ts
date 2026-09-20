import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { NewProject, Project } from './types.js';

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  git_remote: string | null;
  created_at: string;
  last_checked_at: string | null;
  last_head_hash: string | null;
  last_working_tree_clean: number;
  git_status: 'unknown' | 'ok' | 'not-repository' | 'unavailable';
  last_changed_files: number;
  last_untracked_files: number;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    gitRemote: row.git_remote,
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    lastHeadHash: row.last_head_hash,
    lastWorkingTreeClean:
      row.last_working_tree_clean === null ? undefined : row.last_working_tree_clean === 1,
    gitStatus: row.git_status ?? 'unknown',
    lastChangedFiles: row.last_changed_files ?? 0,
    lastUntrackedFiles: row.last_untracked_files ?? 0,
  };
}

export function createProject(db: Database.Database, input: NewProject): Project {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO projects (id, name, path, git_remote) VALUES (?, ?, ?, ?)`
  ).run(id, input.name, input.path, input.gitRemote ?? null);

  const created = getProjectById(db, id);
  if (created) {
    return created;
  }

  return {
    id,
    name: input.name,
    path: input.path,
    gitRemote: input.gitRemote ?? null,
    createdAt: new Date().toISOString(),
  };
}

export function getProjectById(db: Database.Database, id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined;
  return row ? toProject(row) : null;
}

export function getProjectByPath(db: Database.Database, path: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as
    | ProjectRow
    | undefined;
  return row ? toProject(row) : null;
}

export function listProjects(db: Database.Database): Project[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY created_at DESC, rowid DESC')
    .all() as ProjectRow[];
  return rows.map(toProject);
}

export function deleteProject(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function updateProjectName(db: Database.Database, id: string, name: string): Project | null {
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name.trim(), id);
  return getProjectById(db, id);
}

export function relocateProject(db: Database.Database, id: string, path: string): Project | null {
  db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(path, id);
  return getProjectById(db, id);
}
