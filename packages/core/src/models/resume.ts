import type Database from 'better-sqlite3';
import type { ResumeContext } from './types.js';
import { listDecisionsForProject } from './decisions.js';
import { listEntriesForProject } from './entries.js';
import { listCheckpointsForProject } from './checkpoints.js';
import { getProjectById } from './projects.js';
import { listExperimentsForProject } from './experiments.js';

export function getResumeContext(db: Database.Database, projectId: string): ResumeContext {
  const project = getProjectById(db, projectId);
  if (!project) throw new Error('Project not found.');

  const latestCheckpoint = listCheckpointsForProject(db, projectId)[0] ?? null;
  const allEntries = listEntriesForProject(db, projectId);
  const allDecisions = listDecisionsForProject(db, projectId);
  const allExperiments = listExperimentsForProject(db, projectId);
  const runningExperiments = allExperiments.filter((experiment) => experiment.status === 'planned' || experiment.status === 'running');
  const activeDecisions = allDecisions.filter(
    (decision) => decision.status === 'active' || decision.status === 'experimental'
  ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const since = latestCheckpoint?.createdAt ?? project.createdAt;
  const recentEntries = allEntries.filter((entry) => entry.createdAt > since).slice(0, 8);
  const commitsSinceCheckpoint = (db.prepare(
    `SELECT COUNT(*) AS count FROM commits_cache
     WHERE project_id = ? AND datetime(date) > datetime(?)`
  ).get(projectId, since) as { count: number }).count;
  const researchCount = (db.prepare(
    'SELECT COUNT(*) AS count FROM research_items WHERE project_id = ?'
  ).get(projectId) as { count: number }).count;

  const activityDates = [
    project.createdAt,
    latestCheckpoint?.createdAt,
    allEntries[0]?.updatedAt,
    ...allDecisions.map((decision) => decision.updatedAt),
    ...allExperiments.map((experiment) => experiment.updatedAt),
  ].filter((value): value is string => Boolean(value));
  const lastActiveAt = activityDates.sort((a, b) => b.localeCompare(a))[0];
  const normalizedLastActiveAt = lastActiveAt.includes('T')
    ? lastActiveAt
    : `${lastActiveAt.replace(' ', 'T')}Z`;
  const inactiveDays = Math.max(
    0,
    Math.floor((Date.now() - new Date(normalizedLastActiveAt).getTime()) / 86_400_000)
  );
  const suggestedNextStep =
    latestCheckpoint?.nextStep ||
    latestCheckpoint?.openQuestions ||
    activeDecisions[0]?.reason ||
    'Create a checkpoint to preserve the current mental state.';

  return {
    lastActiveAt,
    inactiveDays,
    latestCheckpoint,
    activeDecisions,
    recentEntries,
    commitsSinceCheckpoint,
    changedFiles: project.lastChangedFiles ?? 0,
    researchCount,
    experimentCount: allExperiments.length,
    runningExperiments,
    suggestedNextStep,
  };
}
