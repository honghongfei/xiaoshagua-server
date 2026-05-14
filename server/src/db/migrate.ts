import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from './sqlite.js';
import { log } from '../log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

interface MigrationRow {
  id: string;
  applied_at: number;
}

function ensureTable(db: ReturnType<typeof openDb>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migration (
      id          TEXT PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    );
  `);
}

function listMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function runMigrations(): { applied: string[]; skipped: string[] } {
  const db = openDb();
  ensureTable(db);

  const applied: string[] = [];
  const skipped: string[] = [];
  const done = new Set(
    db.prepare<[], MigrationRow>('SELECT id, applied_at FROM _migration').all().map((r) => r.id),
  );

  for (const file of listMigrationFiles()) {
    if (done.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migration (id, applied_at) VALUES (?, ?)').run(file, Date.now());
    });
    tx();
    applied.push(file);
    log.info({ file }, 'migration applied');
  }

  return { applied, skipped };
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return entry === self;
}

if (isMain()) {
  try {
    const result = runMigrations();
    log.info(result, 'migrations finished');
  } catch (err) {
    log.error({ err }, 'migration failed');
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}
