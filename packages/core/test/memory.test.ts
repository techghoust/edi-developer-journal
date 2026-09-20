import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  openDatabase,
  createProject,
  createCheckpoint,
  createDecision,
  getDecisionRelations,
  listDecisionsForProject,
  updateDecision,
  createEntry,
  getResumeContext,
  createResearchItem,
  listMemoryTimeline,
  createAssumption,
  createExperiment,
  listExperimentsForProject,
} from '../src/index.js';

let db: Database.Database;
let projectId: string;

beforeEach(() => {
  db = openDatabase({ filePath: ':memory:' });
  projectId = createProject(db, { name: 'Memory Project', path: '/repos/memory' }).id;
});

describe('EDI Developer Journal', () => {
  it('stores a decision lineage and its relations', () => {
    const root = createDecision(db, {
      projectId,
      title: 'Use SQLite',
      reason: 'Fast local prototype',
      commitHashes: ['abc'],
      filePaths: ['src/db.ts'],
    });
    const replacement = createDecision(db, {
      projectId,
      title: 'Adopt PostgreSQL',
      status: 'experimental',
      parentDecisionId: root.id,
      reason: 'Concurrent writers are now required',
    });
    updateDecision(db, root.id, {
      status: 'superseded',
      replacementDecisionId: replacement.id,
    });

    const decisions = listDecisionsForProject(db, projectId);
    expect(decisions).toHaveLength(2);
    expect(decisions[0].replacementDecisionId).toBe(replacement.id);
    expect(decisions[1].parentDecisionId).toBe(root.id);
    expect(getDecisionRelations(db, root.id)).toMatchObject({
      commitHashes: ['abc'],
      filePaths: ['src/db.ts'],
    });
  });

  it('builds resume context from checkpoint, decisions, entries, commits, and research', () => {
    const checkpoint = createCheckpoint(db, {
      projectId,
      title: 'Transport paused',
      workingOn: 'Reconnect logic',
      openQuestions: 'Where should backoff state live?',
      nextStep: 'Extract reconnect state machine',
    });
    db.prepare("UPDATE checkpoints SET created_at = '2020-01-01 00:00:00' WHERE id = ?")
      .run(checkpoint.id);
    createDecision(db, {
      projectId,
      title: 'Transport abstraction',
      status: 'active',
      reason: 'Keep reconnect policy replaceable',
    });
    createEntry(db, { projectId, title: 'Investigated exponential backoff' });
    db.prepare(
      `INSERT INTO commits_cache (id, project_id, hash, message, author, date)
       VALUES ('commit-row', ?, 'abc', 'Reconnect experiment', 'Dev', '2021-01-01T00:00:00Z')`
    ).run(projectId);
    createResearchItem(db, {
      projectId,
      type: 'link',
      title: 'Backoff strategies',
      pathOrUrl: 'https://example.com/backoff',
    });
    db.prepare('UPDATE projects SET last_changed_files = 14 WHERE id = ?').run(projectId);

    const context = getResumeContext(db, projectId);
    expect(context.latestCheckpoint?.workingOn).toBe('Reconnect logic');
    expect(context.activeDecisions.map((decision) => decision.title)).toContain('Transport abstraction');
    expect(context.recentEntries.map((entry) => entry.title)).toContain('Investigated exponential backoff');
    expect(context.commitsSinceCheckpoint).toBe(1);
    expect(context.changedFiles).toBe(14);
    expect(context.researchCount).toBe(1);
    expect(context.suggestedNextStep).toBe('Extract reconnect state machine');

    const timeline = listMemoryTimeline(db, projectId);
    expect(timeline.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['journal', 'checkpoint', 'decision', 'research'])
    );
  });

  it('stores experiments, assumptions, and their evidence relationships', () => {
    const assumption = createAssumption(db, {
      projectId,
      statement: 'Processing must remain local',
    });
    const research = createResearchItem(db, {
      projectId,
      type: 'link',
      title: 'Transport comparison',
      pathOrUrl: 'https://example.com/transports',
    });
    const decision = createDecision(db, {
      projectId,
      title: 'Keep reconnect state in session layer',
      temporary: true,
      revisitCondition: 'after MVP',
      assumptionIds: [assumption.id],
    });
    const experiment = createExperiment(db, {
      projectId,
      title: 'Reconnect inside transport',
      hypothesis: 'Reconnect belongs in transport',
      result: 'Transport became coupled to session state',
      conclusion: 'Move reconnect into the session layer',
      status: 'failed',
      resultingDecisionId: decision.id,
      researchIds: [research.id],
      assumptionIds: [assumption.id],
      filePaths: ['src/transport.ts'],
      commitHashes: ['abc123'],
    });

    expect(listExperimentsForProject(db, projectId)[0]).toMatchObject({
      id: experiment.id,
      status: 'failed',
      assumptionIds: [assumption.id],
      researchIds: [research.id],
      resultingDecisionId: decision.id,
    });
    expect(listMemoryTimeline(db, projectId).map((item) => item.kind)).toEqual(
      expect.arrayContaining(['experiment', 'assumption'])
    );
    expect((db.prepare('SELECT COUNT(*) count FROM failure_memory WHERE project_id=?').get(projectId) as { count: number }).count).toBe(1);
    expect((db.prepare('SELECT COUNT(*) count FROM decision_debt WHERE project_id=?').get(projectId) as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) count FROM edi_memory_relationships WHERE project_id=? AND source_kind='decision' AND source_id=? AND target_kind='experiment'").get(projectId, decision.id) as { count: number }).count).toBe(1);
  });
});
