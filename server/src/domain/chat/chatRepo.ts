import { openDb } from '../../db/sqlite.js';

export interface ChatLogRow {
  id: number;
  ts: number;
  channel: string;
  from_id: number;
  to_id: number | null;
  text: string;
}

export function insertChat(
  ts: number,
  channel: string,
  fromId: number,
  toId: number | null,
  text: string,
): void {
  const db = openDb();
  db.prepare(
    'INSERT INTO chat_log (ts, channel, from_id, to_id, text) VALUES (?, ?, ?, ?, ?)',
  ).run(ts, channel, fromId, toId, text);
}

export function recentChat(channel: string, limit = 50): ChatLogRow[] {
  const db = openDb();
  return db
    .prepare<[string, number], ChatLogRow>(
      'SELECT * FROM chat_log WHERE channel = ? ORDER BY id DESC LIMIT ?',
    )
    .all(channel, limit);
}
