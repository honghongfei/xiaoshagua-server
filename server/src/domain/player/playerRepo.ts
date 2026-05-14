import { openDb } from '../../db/sqlite.js';

export interface AccountRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
  last_login_at: number | null;
  banned: number;
}

export interface CharacterRow {
  id: number;
  account_id: number;
  name: string;
  actor_id: number;
  map_id: number;
  x: number;
  y: number;
  direction: number;
  char_set: string | null;
  char_index: number;
  gold: number;
  level: number;
  exp: number;
  extra_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface AuthTokenRow {
  token: string;
  account_id: number;
  character_id: number;
  issued_at: number;
  expires_at: number;
}

export function findAccountByUsername(username: string): AccountRow | undefined {
  const db = openDb();
  return db
    .prepare<[string], AccountRow>('SELECT * FROM account WHERE username = ?')
    .get(username);
}

export function findAccountById(id: number): AccountRow | undefined {
  const db = openDb();
  return db.prepare<[number], AccountRow>('SELECT * FROM account WHERE id = ?').get(id);
}

export interface CreateAccountInput {
  username: string;
  passwordHash: string;
}

export function createAccount(input: CreateAccountInput): number {
  const db = openDb();
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO account (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(input.username, input.passwordHash, now);
  return Number(info.lastInsertRowid);
}

export function touchLastLogin(accountId: number): void {
  const db = openDb();
  db.prepare('UPDATE account SET last_login_at = ? WHERE id = ?').run(Date.now(), accountId);
}

export interface CreateCharacterInput {
  accountId: number;
  name: string;
  actorId?: number;
  charSet?: string | null;
  charIndex?: number;
  mapId?: number;
  x?: number;
  y?: number;
}

export function createCharacter(input: CreateCharacterInput): number {
  const db = openDb();
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO character
       (account_id, name, actor_id, map_id, x, y, direction, char_set, char_index, gold, level, exp, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, 0, 1, 0, ?, ?)`,
    )
    .run(
      input.accountId,
      input.name,
      input.actorId ?? 1,
      input.mapId ?? 1,
      input.x ?? 8,
      input.y ?? 6,
      input.charSet ?? null,
      input.charIndex ?? 0,
      now,
      now,
    );
  return Number(info.lastInsertRowid);
}

export function findFirstCharacterOfAccount(accountId: number): CharacterRow | undefined {
  const db = openDb();
  return db
    .prepare<[number], CharacterRow>(
      'SELECT * FROM character WHERE account_id = ? ORDER BY id ASC LIMIT 1',
    )
    .get(accountId);
}

export function findCharacterById(id: number): CharacterRow | undefined {
  const db = openDb();
  return db.prepare<[number], CharacterRow>('SELECT * FROM character WHERE id = ?').get(id);
}

export function updateCharacterPosition(
  characterId: number,
  mapId: number,
  x: number,
  y: number,
  direction: number,
): void {
  const db = openDb();
  db.prepare(
    'UPDATE character SET map_id = ?, x = ?, y = ?, direction = ?, updated_at = ? WHERE id = ?',
  ).run(mapId, x, y, direction, Date.now(), characterId);
}

export function insertAuthToken(row: AuthTokenRow): void {
  const db = openDb();
  db.prepare(
    'INSERT INTO auth_token (token, account_id, character_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(row.token, row.account_id, row.character_id, row.issued_at, row.expires_at);
}

export function findAuthToken(token: string): AuthTokenRow | undefined {
  const db = openDb();
  return db.prepare<[string], AuthTokenRow>('SELECT * FROM auth_token WHERE token = ?').get(token);
}

export function deleteAuthToken(token: string): void {
  const db = openDb();
  db.prepare('DELETE FROM auth_token WHERE token = ?').run(token);
}

export function pruneExpiredTokens(): number {
  const db = openDb();
  const info = db.prepare('DELETE FROM auth_token WHERE expires_at < ?').run(Date.now());
  return info.changes;
}
