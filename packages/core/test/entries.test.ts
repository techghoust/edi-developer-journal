import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/client.js';
import { createProject } from '../src/models/projects.js';
import {
  createEntry,
  updateEntry,
  addTagToEntry,
  getTagsForEntry,
  linkEntryToCommit,
  getCommitsForEntry,
  searchEntries,
  listEntriesForProject,
  setTagsForEntry,
  setCommitsForEntry,
} from '../src/models/entries.js';

let db: Database.Database;
let projectId: string;

beforeEach(() => {
  db = openDatabase({ filePath: ':memory:' });
  projectId = createProject(db, { name: 'MISS TI', path: '/repos/miss-ti' }).id;
});

describe('entries repository', () => {
  it('creates a manual entry by default', () => {
    const entry = createEntry(db, { projectId, title: 'Initial setup' });
    expect(entry.source).toBe('manual');
    expect(entry.bodyMd).toBe('');
  });

  it('creates an auto entry', () => {
    const entry = createEntry(db, { projectId, title: 'Auto note', source: 'auto' });
    expect(entry.source).toBe('auto');
  });

  it('updates title and body, bumping updated_at', () => {
    const entry = createEntry(db, { projectId, title: 'Draft' });
    const updated = updateEntry(db, entry.id, { title: 'Final', bodyMd: '# done' });
    expect(updated?.title).toBe('Final');
    expect(updated?.bodyMd).toBe('# done');
  });

  it('adds and lists tags without duplicates', () => {
    const entry = createEntry(db, { projectId, title: 'Tagged' });
    addTagToEntry(db, entry.id, 'Architecture');
    addTagToEntry(db, entry.id, 'architecture');
    addTagToEntry(db, entry.id, 'refactor');
    expect(getTagsForEntry(db, entry.id)).toEqual(['architecture', 'refactor']);
  });

  it('links an entry to a commit hash', () => {
    const entry = createEntry(db, { projectId, title: 'Commit link' });
    linkEntryToCommit(db, entry.id, projectId, 'abc123');
    expect(getCommitsForEntry(db, entry.id)).toEqual(['abc123']);
  });

  it('replaces tags and commit links', () => {
    const entry = createEntry(db, { projectId, title: 'Linked decision' });
    setTagsForEntry(db, entry.id, ['Architecture', 'release', 'architecture']);
    setCommitsForEntry(db, entry.id, projectId, ['abc', 'def', 'abc']);
    setTagsForEntry(db, entry.id, ['final']);
    setCommitsForEntry(db, entry.id, projectId, ['def']);

    expect(getTagsForEntry(db, entry.id)).toEqual(['final']);
    expect(getCommitsForEntry(db, entry.id)).toEqual(['def']);
  });

  it('lists entries for a project newest first', () => {
    createEntry(db, { projectId, title: 'first' });
    createEntry(db, { projectId, title: 'second' });
    expect(listEntriesForProject(db, projectId)).toHaveLength(2);
  });

  it('full-text searches entry title and body', () => {
    createEntry(db, {
      projectId,
      title: 'CC4 Blender Bridge',
      bodyMd: 'Reworked the JSON manifest export via RLPy API',
    });
    createEntry(db, { projectId, title: 'Unrelated', bodyMd: 'Something else entirely' });

    const results = searchEntries(db, 'manifest');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('CC4 Blender Bridge');
  });
});
