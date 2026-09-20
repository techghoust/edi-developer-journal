import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/client.js';
import { createProject } from '../src/models/projects.js';
import {
  createCheckpoint,
  getCommitsForCheckpoint,
  listCheckpointsForProject,
  deleteCheckpoint,
  getCheckpointRelations,
} from '../src/models/checkpoints.js';

let db: Database.Database;
let projectId: string;

beforeEach(() => {
  db = openDatabase({ filePath: ':memory:' });
  projectId = createProject(db, { name: 'MISS TI', path: '/repos/miss-ti' }).id;
});

describe('checkpoints repository', () => {
  it('creates a checkpoint with linked commits', () => {
    const checkpoint = createCheckpoint(db, {
      projectId,
      title: 'MVP export pipeline works',
      note: 'FBX + JSON manifest round-trips cleanly',
      commitHashes: ['a1', 'a2'],
    });
    expect(checkpoint.title).toBe('MVP export pipeline works');
    expect(getCommitsForCheckpoint(db, checkpoint.id).sort()).toEqual(['a1', 'a2']);
  });

  it('defaults note to empty string', () => {
    const checkpoint = createCheckpoint(db, { projectId, title: 'No note' });
    expect(checkpoint.note).toBe('');
    expect(checkpoint.workingOn).toBe('');
  });

  it('captures project mental state and related files', () => {
    const checkpoint = createCheckpoint(db, {
      projectId,
      title: 'Reconnect work paused',
      workingOn: 'WebSocket reconnect logic',
      currentWorks: 'Initial connection',
      brokenOrUnfinished: 'Backoff resets too early',
      tryingToUnderstand: 'Where reconnect state belongs',
      decisionsMade: 'Keep transport behind an interface',
      alternativesRejected: 'Polling adds avoidable latency',
      openQuestions: 'Should state live above transport?',
      nextStep: 'Extract reconnect state machine',
      filePaths: ['src/transport.ts'],
    });

    expect(checkpoint.nextStep).toBe('Extract reconnect state machine');
    expect(getCheckpointRelations(db, checkpoint.id).filePaths).toEqual(['src/transport.ts']);
  });

  it('lists checkpoints for a project', () => {
    createCheckpoint(db, { projectId, title: 'first' });
    createCheckpoint(db, { projectId, title: 'second' });
    expect(listCheckpointsForProject(db, projectId)).toHaveLength(2);
  });

  it('deletes a checkpoint and cascades commit links', () => {
    const checkpoint = createCheckpoint(db, {
      projectId,
      title: 'temp',
      commitHashes: ['x1'],
    });
    deleteCheckpoint(db, checkpoint.id);
    expect(getCommitsForCheckpoint(db, checkpoint.id)).toEqual([]);
  });
});
