import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';
import {
  getRepositoryRemote,
  getRepositoryStatus,
  listRecentCommits,
  refreshProjectGitMetadata,
} from '../src/git/index.js';
import {
  openDatabase,
  createProject,
  getCachedCommitsForProject,
  listEntriesForProject,
  getCommitsForEntry,
} from '../src/index.js';

describe('Git integration module', () => {
  let tempRepoPath: string | null = null;

  afterEach(() => {
    if (tempRepoPath) {
      rmSync(tempRepoPath, { recursive: true, force: true });
      tempRepoPath = null;
    }
  });

  it('reads the remote origin URL from a repository', async () => {
    tempRepoPath = mkdtempSync(join(os.tmpdir(), 'dj-git-'));
    const git = simpleGit({ baseDir: tempRepoPath });

    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    await writeFileSync(join(tempRepoPath, 'README.md'), '# Remote Test');
    await git.add('.');
    await git.commit('Add README');
    await git.addRemote('origin', 'https://example.com/test-repo.git');

    const remote = await getRepositoryRemote(tempRepoPath);

    expect(remote).toBe('https://example.com/test-repo.git');
  });

  it('lists recent commits from a repository', async () => {
    tempRepoPath = mkdtempSync(join(os.tmpdir(), 'dj-git-'));
    const git = simpleGit({ baseDir: tempRepoPath });

    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    writeFileSync(join(tempRepoPath, 'README.md'), '# Commit List');
    await git.add('.');
    await git.commit('First commit');
    writeFileSync(join(tempRepoPath, 'CHANGELOG.md'), 'Update');
    await git.add('.');
    await git.commit('Second commit');

    const commits = await listRecentCommits(tempRepoPath, 10);

    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(commits[0]).toHaveProperty('hash');
    expect(commits[0]).toHaveProperty('message');
    expect(commits[0]).toHaveProperty('author');
    expect(commits[0]).toHaveProperty('date');
    expect(commits.map((c) => c.message)).toContain('Second commit');
  });

  it('refreshes and caches Git metadata for a project', async () => {
    tempRepoPath = mkdtempSync(join(os.tmpdir(), 'dj-git-'));
    const git = simpleGit({ baseDir: tempRepoPath });

    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    writeFileSync(join(tempRepoPath, 'README.md'), '# Cache Test');
    await git.add('.');
    await git.commit('Cache commit');

    const db = openDatabase({ filePath: ':memory:' });
    const project = createProject(db, { name: 'Git Cache', path: tempRepoPath });

    const metadata = await refreshProjectGitMetadata(db, project.id, tempRepoPath, 5);
    const cachedCommits = getCachedCommitsForProject(db, project.id);

    expect(metadata.commits.length).toBeGreaterThanOrEqual(1);
    expect(cachedCommits.length).toBeGreaterThanOrEqual(1);
    expect(cachedCommits[0].hash).toBe(metadata.commits[0].hash);
  });

  it('distinguishes a regular folder from a clean Git repository', async () => {
    tempRepoPath = mkdtempSync(join(os.tmpdir(), 'dj-folder-'));

    const status = await getRepositoryStatus(tempRepoPath);

    expect(status.state).toBe('not-repository');
    expect(status.summary).toContain('not a Git repository');
  });

  it('creates one auto entry for a new commit but not for an uncommitted file change', async () => {
    tempRepoPath = mkdtempSync(join(os.tmpdir(), 'dj-auto-entry-'));
    const git = simpleGit({ baseDir: tempRepoPath });
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    writeFileSync(join(tempRepoPath, 'README.md'), '# Initial');
    await git.add('.');
    await git.commit('Initial commit');

    const db = openDatabase({ filePath: ':memory:' });
    const project = createProject(db, { name: 'Auto entry', path: tempRepoPath });
    await refreshProjectGitMetadata(db, project.id, tempRepoPath, 10);

    writeFileSync(join(tempRepoPath, 'README.md'), '# Work in progress');
    await refreshProjectGitMetadata(db, project.id, tempRepoPath, 10);
    expect(listEntriesForProject(db, project.id)).toHaveLength(0);

    await git.add('.');
    await git.commit('Finish journal editing');
    const head = await git.revparse(['HEAD']);
    await refreshProjectGitMetadata(db, project.id, tempRepoPath, 10);

    const entries = listEntriesForProject(db, project.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Finish journal editing');
    expect(getCommitsForEntry(db, entries[0].id)).toEqual([head]);
  });
});
