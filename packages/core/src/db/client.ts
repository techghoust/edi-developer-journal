import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

type SqliteLikeDatabase = Database.Database & {
  prepare: Database.Database['prepare'];
  exec: Database.Database['exec'];
};

export interface DbOptions {
  filePath: string;
}

export function openDatabase(options: DbOptions): Database.Database {
  let db: SqliteLikeDatabase;

  try {
    db = new Database(options.filePath) as SqliteLikeDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
  } catch (error) {
    console.error('[openDatabase] failed to open SQLite database:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function runMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = db
    .prepare(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name TEXT PRIMARY KEY,
         applied_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    )
    .run();
  void applied;

  const alreadyApplied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name)
  );

  for (const file of files) {
    if (alreadyApplied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }
}
