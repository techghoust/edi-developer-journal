import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';
import type Database from 'better-sqlite3';
import {
  createProject,
  getCachedCommitsForProject,
  getProjectByPath,
  openDatabase,
  refreshProjectGitMetadata,
} from '../src/index.js';

let db: Database.Database;
let projectId: string;
let tempRepoPath: string | null = null;

beforeEach(() => {
  db = openDatabase({ filePath: ':memory:' });
  projectId = createProject(db, { name: 'Core Root', path: '/repos/core-root' }).id;
});

afterEach(() => {
  if (tempRepoPath) {
    rmSync(tempRepoPath, { recursive: true, force: true });
    tempRepoPath = null;
  }
});

describe('packages/core index exports', () => {
  it('exposes the shared repository API through the barrel export', () => {
    const project = getProjectByPath(db, '/repos/core-root');
    expect(project).not.toBeNull();
    expect(project?.id).toBe(projectId);
  });
});

describe('Git metadata integration', () => {
  it('refreshes project Git metadata and caches commits', async () => {
    tempRepoPath = mkdtempSync(join(os.tmpdir(), 'dj-core-test-'));
    const git = simpleGit({ baseDir: tempRepoPath });

    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    writeFileSync(join(tempRepoPath, 'README.md'), '# Developer Journal Git Test');
    await git.add('.');
    await git.commit('Initial commit');

    const project = createProject(db, { name: 'Git Repo', path: tempRepoPath });
    const metadata = await refreshProjectGitMetadata(db, project.id, tempRepoPath, 5);

    expect(metadata.gitRemote).toBeNull();
    expect(metadata.commits.length).toBeGreaterThanOrEqual(1);
    expect(getCachedCommitsForProject(db, project.id).length).toBeGreaterThanOrEqual(1);
    expect(getCachedCommitsForProject(db, project.id)[0]?.hash).toBe(metadata.commits[0]?.hash);
  });
});
