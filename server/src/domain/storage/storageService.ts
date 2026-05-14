import { openDb } from '../../db/sqlite.js';
import { AppError } from '../../util/errors.js';

const MAX_BLOB_BYTES = 2_000_000;

export interface SaveBlob {
  ts: number;
  contents: string;
  meta?: Record<string, unknown>;
}

export function uploadSave(characterId: number, contents: string, meta?: Record<string, unknown>): SaveBlob {
  if (typeof contents !== 'string') throw new AppError('BAD_INPUT', 'contents must be string');
  if (Buffer.byteLength(contents, 'utf8') > MAX_BLOB_BYTES) {
    throw new AppError('BLOB_TOO_LARGE', `save blob >${MAX_BLOB_BYTES} bytes`);
  }
  const db = openDb();
  const ts = Date.now();
  const metaStr = meta ? JSON.stringify(meta) : null;
  db.prepare(
    `INSERT INTO savefile_cloud (character_id, ts, contents, meta) VALUES (?, ?, ?, ?)
     ON CONFLICT(character_id) DO UPDATE SET ts = excluded.ts, contents = excluded.contents, meta = excluded.meta`,
  ).run(characterId, ts, contents, metaStr);
  return { ts, contents, meta };
}

export function downloadSave(characterId: number): SaveBlob | null {
  const db = openDb();
  const row = db
    .prepare<[number], { ts: number; contents: string; meta: string | null }>(
      'SELECT ts, contents, meta FROM savefile_cloud WHERE character_id = ?',
    )
    .get(characterId);
  if (!row) return null;
  return {
    ts: row.ts,
    contents: row.contents,
    meta: row.meta ? safeParse(row.meta) : undefined,
  };
}

export function hasSave(characterId: number): boolean {
  const db = openDb();
  const row = db
    .prepare<[number], { c: number }>(
      'SELECT 1 AS c FROM savefile_cloud WHERE character_id = ? LIMIT 1',
    )
    .get(characterId);
  return !!row;
}

function safeParse(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
