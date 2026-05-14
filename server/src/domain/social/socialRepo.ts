import { openDb } from '../../db/sqlite.js';

export interface SocialRow {
  a: number;
  b: number;
  kind: 'friend' | 'block';
  created_at: number;
}

export function addRelation(a: number, b: number, kind: 'friend' | 'block'): void {
  const db = openDb();
  db.prepare(
    'INSERT OR IGNORE INTO social_relation (a, b, kind, created_at) VALUES (?, ?, ?, ?)',
  ).run(a, b, kind, Date.now());
}

export function removeRelation(a: number, b: number, kind: 'friend' | 'block'): void {
  const db = openDb();
  db.prepare('DELETE FROM social_relation WHERE a = ? AND b = ? AND kind = ?').run(a, b, kind);
}

export function listOutgoing(a: number, kind: 'friend' | 'block'): number[] {
  const db = openDb();
  return db
    .prepare<[number, string], { b: number }>(
      'SELECT b FROM social_relation WHERE a = ? AND kind = ?',
    )
    .all(a, kind)
    .map((r) => r.b);
}

export function isRelation(a: number, b: number, kind: 'friend' | 'block'): boolean {
  const db = openDb();
  const row = db
    .prepare<[number, number, string], { c: number }>(
      'SELECT 1 AS c FROM social_relation WHERE a = ? AND b = ? AND kind = ? LIMIT 1',
    )
    .get(a, b, kind);
  return !!row;
}
