import { openDb } from '../../db/sqlite.js';
import { AppError } from '../../util/errors.js';

const MAX_BLOB_BYTES = 2_000_000;

export interface SaveBlob {
  ts: number;
  contents: string;
  meta?: Record<string, unknown>;
}

export function uploadSave(
  characterId: number,
  contents: string,
  meta?: Record<string, unknown>,
  baseTs?: number,
): SaveBlob {
  if (typeof contents !== 'string') throw new AppError('BAD_INPUT', 'contents must be string');
  if (Buffer.byteLength(contents, 'utf8') > MAX_BLOB_BYTES) {
    throw new AppError('BLOB_TOO_LARGE', `save blob >${MAX_BLOB_BYTES} bytes`);
  }
  const db = openDb();
  // 乐观并发守卫: 仅当客户端给了 baseTs 才校验(向后兼容老客户端).
  // 当前云档比客户端最后见过的还新 -> 拒绝, 避免"没读云就盲写覆盖"(admin 云档被覆盖的根因之一).
  if (typeof baseTs === 'number' && Number.isFinite(baseTs)) {
    const cur = db
      .prepare<[number], { ts: number }>('SELECT ts FROM savefile_cloud WHERE character_id = ?')
      .get(characterId);
    if (cur && cur.ts > baseTs) {
      throw new AppError('SAVE_STALE', `cloud save is newer (cloud=${cur.ts} > base=${baseTs}), refusing overwrite`);
    }
  }
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
