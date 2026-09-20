import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Entry, EntrySource, NewEntry } from './types.js';

interface EntryRow {
  id: string;
  project_id: string;
  title: string;
  body_md: string;
  source: EntrySource;
  created_at: string;
  updated_at: string;
}

function toEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    bodyMd: row.body_md,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createEntry(db: Database.Database, input: NewEntry): Entry {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO entries (id, project_id, title, body_md, source) VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.projectId, input.title, input.bodyMd ?? '', input.source ?? 'manual');
  return getEntryById(db, id)!;
}

export function getEntryById(db: Database.Database, id: string): Entry | null {
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
    | EntryRow
    | undefined;
  return row ? toEntry(row) : null;
}

export function listEntriesForProject(db: Database.Database, projectId: string): Entry[] {
  const rows = db
    .prepare('SELECT * FROM entries WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as EntryRow[];
  return rows.map(toEntry);
}

export function updateEntry(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<Entry, 'title' | 'bodyMd'>>
): Entry | null {
  const existing = getEntryById(db, id);
  if (!existing) return null;
  db.prepare(
    `UPDATE entries SET title = ?, body_md = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(patch.title ?? existing.title, patch.bodyMd ?? existing.bodyMd, id);
  return getEntryById(db, id);
}

export function deleteEntry(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
}

export function addTagToEntry(db: Database.Database, entryId: string, tagName: string): void {
  const normalized = tagName.trim().toLowerCase();
  db.prepare(`INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)`).run(
    randomUUID(),
    normalized
  );
  const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(normalized) as {
    id: string;
  };
  db.prepare(`INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)`).run(
    entryId,
    tag.id
  );
}

export function getTagsForEntry(db: Database.Database, entryId: string): string[] {
  const rows = db
    .prepare(
      `SELECT t.name FROM tags t
       JOIN entry_tags et ON et.tag_id = t.id
       WHERE et.entry_id = ?
       ORDER BY t.name`
    )
    .all(entryId) as { name: string }[];
  return rows.map((r) => r.name);
}

export function setTagsForEntry(db: Database.Database, entryId: string, tagNames: string[]): void {
  const normalizedTags = [...new Set(tagNames.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM entry_tags WHERE entry_id = ?').run(entryId);
    for (const tag of normalizedTags) addTagToEntry(db, entryId, tag);
  });
  tx();
}

export function linkEntryToCommit(
  db: Database.Database,
  entryId: string,
  projectId: string,
  commitHash: string
): void {
  db.prepare(
    `INSERT OR IGNORE INTO entry_commits (entry_id, project_id, commit_hash) VALUES (?, ?, ?)`
  ).run(entryId, projectId, commitHash);
}

export function getCommitsForEntry(db: Database.Database, entryId: string): string[] {
  const rows = db
    .prepare('SELECT commit_hash FROM entry_commits WHERE entry_id = ?')
    .all(entryId) as { commit_hash: string }[];
  return rows.map((r) => r.commit_hash);
}

export function setCommitsForEntry(
  db: Database.Database,
  entryId: string,
  projectId: string,
  commitHashes: string[]
): void {
  const normalizedHashes = [...new Set(commitHashes.map((hash) => hash.trim()).filter(Boolean))];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM entry_commits WHERE entry_id = ?').run(entryId);
    for (const hash of normalizedHashes) linkEntryToCommit(db, entryId, projectId, hash);
  });
  tx();
}

export interface SearchResult {
  entryId: string;
  title: string;
  snippet: string;
}

export function searchEntries(db: Database.Database, query: string): SearchResult[] {
  const rows = db
    .prepare(
      `SELECT e.id AS entryId, e.title AS title,
              snippet(entries_fts, 1, '[', ']', '...', 10) AS snippet
       FROM entries_fts
       JOIN entries e ON e.rowid = entries_fts.rowid
       WHERE entries_fts MATCH ?
       ORDER BY rank`
    )
    .all(query) as SearchResult[];
  return rows;
}
