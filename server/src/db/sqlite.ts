import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { log } from '../log.js';

export type DB = Database.Database;

let _db: DB | null = null;

export function openDb(): DB {
  if (_db) return _db;

  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(config.dbPath, {
    fileMustExist: false,
  });

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  log.info({ path: config.dbPath }, 'sqlite opened (WAL)');
  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    try {
      // 关库前先把 WAL 回写主库并截断, 防异常退出时 WAL 膨胀 / 残留未合并的写入.
      try {
        _db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        log.warn({ err }, 'wal checkpoint on close failed');
      }
      _db.close();
      log.info('sqlite closed');
    } catch (err) {
      log.warn({ err }, 'sqlite close error');
    }
    _db = null;
  }
}

export function withTx<T>(db: DB, fn: (db: DB) => T): T {
  const tx = db.transaction(fn);
  return tx(db);
}
