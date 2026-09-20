import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { NewResearchItem, ResearchItem, ResearchItemType } from './types.js';

interface ResearchRow {
  id: string;
  project_id: string;
  type: ResearchItemType;
  title: string;
  path_or_url: string | null;
  notes: string;
  created_at: string;
}

function toResearchItem(row: ResearchRow): ResearchItem {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    title: row.title,
    pathOrUrl: row.path_or_url,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export function createResearchItem(db: Database.Database, input: NewResearchItem): ResearchItem {
  const id = randomUUID();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO research_items (id, project_id, type, title, path_or_url, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, input.projectId, input.type, input.title, input.pathOrUrl ?? null, input.notes ?? '');
    for (const entryId of input.entryIds ?? []) {
      if (entryId.trim()) {
        db.prepare('INSERT OR IGNORE INTO research_links (research_id, entry_id) VALUES (?, ?)')
          .run(id, entryId.trim());
      }
    }
  });
  tx();
  return getResearchItemById(db, id)!;
}

export function getResearchItemById(db: Database.Database, id: string): ResearchItem | null {
  const row = db.prepare('SELECT * FROM research_items WHERE id = ?').get(id) as ResearchRow | undefined;
  return row ? toResearchItem(row) : null;
}

export function listResearchForProject(db: Database.Database, projectId: string): ResearchItem[] {
  return (db.prepare(
    'SELECT * FROM research_items WHERE project_id = ? ORDER BY created_at DESC, rowid DESC'
  ).all(projectId) as ResearchRow[]).map(toResearchItem);
}

export function getEntriesForResearch(db: Database.Database, researchId: string): string[] {
  return (db.prepare(
    'SELECT entry_id FROM research_links WHERE research_id = ? ORDER BY entry_id'
  ).all(researchId) as { entry_id: string }[]).map((row) => row.entry_id);
}
