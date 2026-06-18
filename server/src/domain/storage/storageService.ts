import { openDb } from '../../db/sqlite.js';
import { AppError } from '../../util/errors.js';

const MAX_BLOB_BYTES = 2_000_000;

export interface SaveBlob {
  ts: number;
  contents: string;
  meta?: Record<string, unknown>;
}

// 存档锁账号: 存档 contents 顶层带归属章 xsgOwner={v,pid,accountId,at}(客户端登录态盖章).
// 上传者 characterId 与章里的 pid 不符 -> 拒绝(SAVE_FOREIGN), 堵"普通朋友拷文件再上传白嫖".
// 无章(老档) / 非法 JSON / pid 非数字 -> fail-open 放行, 不误伤老存档与脏数据.
// JsonEx.stringify 输出是合法 JSON, 这里用 JSON.parse 只取归属字段, 不反序列化 RMMZ 类.
export function assertSaveOwner(contents: string, characterId: number): void {
  let owner: { pid?: unknown } | undefined;
  try {
    owner = (JSON.parse(contents) as { xsgOwner?: { pid?: unknown } }).xsgOwner;
  } catch {
    return;
  }
  if (owner && typeof owner.pid === 'number' && owner.pid !== characterId) {
    throw new AppError(
      'SAVE_FOREIGN',
      `cloud save owner mismatch (save=${owner.pid}, you=${characterId})`,
    );
  }
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
  assertSaveOwner(contents, characterId);
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
