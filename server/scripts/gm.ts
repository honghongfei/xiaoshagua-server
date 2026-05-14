#!/usr/bin/env tsx
/**
 * gm.ts — local GM CLI. Run on the server box (reads same SQLite file).
 *
 * Commands:
 *   npx tsx scripts/gm.ts list-accounts
 *   npx tsx scripts/gm.ts list-online            # online list is a stub (requires REST)
 *   npx tsx scripts/gm.ts ban <accountId>
 *   npx tsx scripts/gm.ts unban <accountId>
 *   npx tsx scripts/gm.ts grant-gold <characterId> <amount>
 *   npx tsx scripts/gm.ts grant-item <characterId> <kind> <dataId> <amount>
 *   npx tsx scripts/gm.ts dump-character <characterId>
 *   npx tsx scripts/gm.ts prune-tokens
 */
import { openDb, closeDb } from '../src/db/sqlite.js';
import { runMigrations } from '../src/db/migrate.js';

function usage(): void {
  console.log(`gm.ts — see header comment for commands.`);
  process.exit(1);
}

function listAccounts(): void {
  const db = openDb();
  const rows = db
    .prepare<[], { id: number; username: string; banned: number; last_login_at: number | null }>(
      'SELECT id, username, banned, last_login_at FROM account ORDER BY id',
    )
    .all();
  console.table(rows.map((r) => ({
    ...r,
    last_login: r.last_login_at ? new Date(r.last_login_at).toISOString() : '-',
  })));
}

function ban(accountId: number, banned: 0 | 1): void {
  const db = openDb();
  const info = db.prepare('UPDATE account SET banned = ? WHERE id = ?').run(banned, accountId);
  console.log('rows affected:', info.changes);
}

function grantGold(characterId: number, amount: number): void {
  const db = openDb();
  db.prepare('UPDATE character SET gold = gold + ?, updated_at = ? WHERE id = ?')
    .run(amount, Date.now(), characterId);
  const row = db.prepare<[number], { gold: number }>('SELECT gold FROM character WHERE id = ?')
    .get(characterId);
  console.log('characterId', characterId, '-> gold =', row && row.gold);
}

function grantItem(characterId: number, kind: string, dataId: number, amount: number): void {
  if (!['item', 'weapon', 'armor'].includes(kind)) throw new Error('bad kind');
  const db = openDb();
  const cur = db
    .prepare<[number, string, number], { count: number }>(
      'SELECT count FROM inventory WHERE character_id = ? AND kind = ? AND data_id = ?',
    )
    .get(characterId, kind, dataId);
  const before = cur ? cur.count : 0;
  const after = Math.max(0, before + amount);
  if (after === 0) {
    db.prepare('DELETE FROM inventory WHERE character_id = ? AND kind = ? AND data_id = ?').run(characterId, kind, dataId);
  } else if (cur) {
    db.prepare('UPDATE inventory SET count = ? WHERE character_id = ? AND kind = ? AND data_id = ?').run(after, characterId, kind, dataId);
  } else {
    db.prepare('INSERT INTO inventory (character_id, kind, data_id, count) VALUES (?, ?, ?, ?)').run(characterId, kind, dataId, after);
  }
  console.log('characterId', characterId, kind + '#' + dataId, ':', before, '->', after);
}

function dumpCharacter(characterId: number): void {
  const db = openDb();
  const ch = db.prepare('SELECT * FROM character WHERE id = ?').get(characterId);
  const inv = db.prepare('SELECT * FROM inventory WHERE character_id = ?').all(characterId);
  const pets = db.prepare('SELECT * FROM pet WHERE character_id = ?').all(characterId);
  const save = db.prepare('SELECT character_id, ts, length(contents) AS bytes FROM savefile_cloud WHERE character_id = ?').get(characterId);
  console.log('character:', ch);
  console.log('inventory:', inv);
  console.log('pets:', pets);
  console.log('savefile_cloud:', save);
}

function pruneTokens(): void {
  const db = openDb();
  const info = db.prepare('DELETE FROM auth_token WHERE expires_at < ?').run(Date.now());
  console.log('pruned', info.changes, 'tokens');
}

async function main() {
  runMigrations();
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  try {
    switch (cmd) {
      case 'list-accounts': listAccounts(); break;
      case 'ban': ban(Number(rest[0]), 1); break;
      case 'unban': ban(Number(rest[0]), 0); break;
      case 'grant-gold': grantGold(Number(rest[0]), Number(rest[1])); break;
      case 'grant-item': grantItem(Number(rest[0]), String(rest[1]), Number(rest[2]), Number(rest[3])); break;
      case 'dump-character': dumpCharacter(Number(rest[0])); break;
      case 'prune-tokens': pruneTokens(); break;
      default:
        console.error('unknown command:', cmd);
        usage();
    }
  } finally {
    closeDb();
  }
}

main().catch((e) => {
  console.error('gm fatal', e);
  closeDb();
  process.exit(1);
});
