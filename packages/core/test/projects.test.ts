import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/client.js';
import { createProject, getProjectByPath, listProjects, deleteProject, relocateProject } from '../src/models/projects.js';

let db: Database.Database;

beforeEach(() => {
  db = openDatabase({ filePath: ':memory:' });
});

describe('migrations', () => {
  it('creates all expected tables', () => {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'projects',
        'entries',
        'tags',
        'entry_tags',
        'attachments',
        'commits_cache',
        'entry_commits',
        'checkpoints',
        'checkpoint_commits',
        'checkpoint_attachments',
        'research_items',
        'research_links',
        'timeline_items',
      ])
    );
  });

  it('is idempotent — running migrations twice does not throw', () => {
    expect(() => openDatabase({ filePath: ':memory:' })).not.toThrow();
  });
});

describe('projects repository', () => {
  it('creates and retrieves a project', () => {
    const project = createProject(db, { name: 'MISS TI', path: '/repos/miss-ti' });
    expect(project.id).toBeTypeOf('string');
    expect(project.name).toBe('MISS TI');
    expect(project.gitRemote).toBeNull();
  });

  it('enforces unique path', () => {
    createProject(db, { name: 'A', path: '/repos/dup' });
    expect(() => createProject(db, { name: 'B', path: '/repos/dup' })).toThrow();
  });

  it('finds project by path', () => {
    createProject(db, { name: 'A', path: '/repos/a' });
    const found = getProjectByPath(db, '/repos/a');
    expect(found?.name).toBe('A');
  });

  it('returns null for unknown path', () => {
    const found = getProjectByPath(db, '/repos/missing');
    expect(found).toBeNull();
  });

  it('lists projects newest first', () => {
    createProject(db, { name: 'first', path: '/repos/1' });
    createProject(db, { name: 'second', path: '/repos/2' });
    const all = listProjects(db);
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe('second');
    expect(all[1].name).toBe('first');
  });

  it('deletes a project', () => {
    const p = createProject(db, { name: 'temp', path: '/repos/temp' });
    db.prepare("INSERT INTO entries(id, project_id, title) VALUES('entry', ?, 'note')").run(p.id);
    db.prepare("INSERT INTO checkpoints(id, project_id, title) VALUES('checkpoint', ?, 'state')").run(p.id);
    db.prepare("INSERT INTO research_items(id, project_id, type, title) VALUES('research', ?, 'link', 'source')").run(p.id);
    db.prepare("INSERT INTO decisions(id, project_id, title) VALUES('decision', ?, 'choice')").run(p.id);
    deleteProject(db, p.id);
    expect(getProjectByPath(db, '/repos/temp')).toBeNull();
    for (const table of ['entries', 'checkpoints', 'research_items', 'decisions']) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it('relocates a project without changing its identity', () => {
    const created = createProject(db, { name: 'Moved project', path: '/repos/old' });
    const relocated = relocateProject(db, created.id, '/repos/new');

    expect(relocated?.id).toBe(created.id);
    expect(relocated?.path).toBe('/repos/new');
    expect(getProjectByPath(db, '/repos/old')).toBeNull();
  });
});
