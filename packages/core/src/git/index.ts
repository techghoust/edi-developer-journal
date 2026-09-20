import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { createEntry, linkEntryToCommit } from '../models/entries.js';
import { getProjectById } from '../models/projects.js';

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface GitStatus {
  state: 'ok' | 'not-repository' | 'unavailable';
  headHash: string | null;
  workingTreeClean: boolean;
  changedFiles: number;
  untrackedFiles: number;
  summary: string;
}

export interface GitMetadata {
  gitRemote: string | null;
  commits: GitCommit[];
  status: GitStatus;
}

function openGitRepo(repoPath: string): SimpleGit {
  return simpleGit({ baseDir: repoPath });
}

export async function getRepositoryRemote(repoPath: string): Promise<string | null> {
  try {
    const git = openGitRepo(repoPath);
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === 'origin');
    return origin?.refs.fetch ?? remotes[0]?.refs.fetch ?? null;
  } catch {
    return null;
  }
}

export async function getRepositoryStatus(repoPath: string): Promise<GitStatus> {
  try {
    const git = openGitRepo(repoPath);
    if (!(await git.checkIsRepo())) {
      return {
        state: 'not-repository',
        headHash: null,
        workingTreeClean: true,
        changedFiles: 0,
        untrackedFiles: 0,
        summary: 'folder is not a Git repository',
      };
    }
    const status = await git.status();
    const headHash = await git.revparse(['HEAD']).catch(() => null);
    const files = status.files ?? [];
    const changedFiles = files.filter((file) => file.working_dir !== ' ' || file.index !== ' ').length;
    const untrackedFiles = files.filter((file) => file.working_dir === '?' && file.index === '?').length;
    const workingTreeClean = status.isClean();
    const summary = workingTreeClean
      ? 'working tree is clean'
      : `${changedFiles} changed file(s), ${untrackedFiles} untracked file(s)`;

    return {
      state: 'ok',
      headHash,
      workingTreeClean,
      changedFiles,
      untrackedFiles,
      summary,
    };
  } catch {
    return {
      state: 'unavailable',
      headHash: null,
      workingTreeClean: true,
      changedFiles: 0,
      untrackedFiles: 0,
      summary: 'Git status is unavailable',
    };
  }
}

export async function listRecentCommits(repoPath: string, maxCount = 50): Promise<GitCommit[]> {
  try {
    const git = openGitRepo(repoPath);
    const log = await git.log({ maxCount });
    return log.all.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
      author: commit.author_name,
      date: commit.date,
    }));
  } catch {
    return [];
  }
}

export function cacheCommitsForProject(db: Database.Database, projectId: string, commits: GitCommit[]): void {
  const tx = db.transaction(() => {
    for (const commit of commits) {
      db.prepare(
        `INSERT OR IGNORE INTO commits_cache (id, project_id, hash, message, author, date)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), projectId, commit.hash, commit.message, commit.author, commit.date);
    }
  });

  tx();
}

export function getCachedCommitsForProject(db: Database.Database, projectId: string): GitCommit[] {
  const rows = db
    .prepare(
      'SELECT hash, message, author, date FROM commits_cache WHERE project_id = ? ORDER BY date DESC'
    )
    .all(projectId) as Array<{ hash: string; message: string; author: string; date: string }>;
  return rows.map((row) => ({
    hash: row.hash,
    message: row.message,
    author: row.author,
    date: row.date,
  }));
}

export function setProjectGitRemote(db: Database.Database, projectId: string, gitRemote: string | null): void {
  db.prepare('UPDATE projects SET git_remote = ? WHERE id = ?').run(gitRemote, projectId);
}

export function setProjectGitStatus(db: Database.Database, projectId: string, status: GitStatus): void {
  db.prepare(
    `UPDATE projects SET last_checked_at = datetime('now'), last_head_hash = ?,
       last_working_tree_clean = ?, git_status = ?, last_changed_files = ?,
       last_untracked_files = ? WHERE id = ?`
  ).run(
    status.headHash,
    status.workingTreeClean ? 1 : 0,
    status.state,
    status.changedFiles,
    status.untrackedFiles,
    projectId
  );
}

export function createAutoEntryForGitChanges(
  db: Database.Database,
  projectId: string,
  status: GitStatus,
  commits: GitCommit[]
): void {
  const project = getProjectById(db, projectId);
  if (!project) return;
  if (
    status.state !== 'ok' ||
    !status.headHash ||
    !project.lastHeadHash ||
    project.lastHeadHash === status.headHash
  ) return;

  const newCommits: GitCommit[] = [];
  for (const commit of commits) {
    if (commit.hash === project.lastHeadHash) break;
    newCommits.push(commit);
  }
  const body = [
    `HEAD changed from ${project.lastHeadHash} to ${status.headHash}.`,
    '',
    '## New commits',
    ...(newCommits.length > 0
      ? newCommits.map((commit) => `- ${commit.hash.slice(0, 7)} ${commit.message}`)
      : ['- Commit range is not available in the local history.']),
  ].join('\n');

  const entry = createEntry(db, {
    projectId,
    title: newCommits.length === 1 ? newCommits[0].message : `${newCommits.length || 1} new commits`,
    bodyMd: body,
    source: 'auto',
  });

  for (const commit of newCommits) {
    linkEntryToCommit(db, entry.id, projectId, commit.hash);
  }
}

export async function refreshProjectGitMetadata(
  db: Database.Database,
  projectId: string,
  projectPath: string,
  maxCommits = 100
): Promise<GitMetadata> {
  const gitRemote = await getRepositoryRemote(projectPath);
  const status = await getRepositoryStatus(projectPath);
  const commits = status.state === 'ok' ? await listRecentCommits(projectPath, maxCommits) : [];

  setProjectGitRemote(db, projectId, gitRemote);
  createAutoEntryForGitChanges(db, projectId, status, commits);
  setProjectGitStatus(db, projectId, status);

  if (commits.length > 0) {
    cacheCommitsForProject(db, projectId, commits);
  }

  return { gitRemote, commits, status };
}
