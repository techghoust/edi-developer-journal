import type Database from 'better-sqlite3';
import type { MemoryTimelineItem } from './types.js';

interface TimelineRow {
  id: string;
  project_id: string;
  kind: MemoryTimelineItem['kind'];
  title: string;
  occurred_at: string;
}

export function listMemoryTimeline(
  db: Database.Database,
  projectId: string,
  limit = 20
): MemoryTimelineItem[] {
  const rows = db.prepare(
    `SELECT id, project_id, kind, title, occurred_at
     FROM project_memory_timeline
     WHERE project_id = ?
     ORDER BY datetime(occurred_at) DESC
     LIMIT ?`
  ).all(projectId, limit) as TimelineRow[];
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    occurredAt: row.occurred_at,
  }));
}
