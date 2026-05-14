#!/usr/bin/env tsx
/**
 * loadtest.ts — spin up N fake clients that register, enterMap, and wander.
 *
 * Usage:
 *   npx tsx scripts/loadtest.ts --players 30 --url http://127.0.0.1:3000 --map 1 --duration 60
 */
import { io as ioClient, type Socket } from 'socket.io-client';

interface Args {
  players: number;
  url: string;
  mapId: number;
  durationSec: number;
  moveHz: number;
}

function parseArgs(): Args {
  const out: Args = {
    players: 30,
    url: 'http://127.0.0.1:3000',
    mapId: 1,
    durationSec: 60,
    moveHz: 2,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (!next) continue;
    if (a === '--players') out.players = Number(next);
    else if (a === '--url') out.url = next;
    else if (a === '--map') out.mapId = Number(next);
    else if (a === '--duration') out.durationSec = Number(next);
    else if (a === '--hz') out.moveHz = Number(next);
  }
  return out;
}

interface Fake {
  id: number;
  username: string;
  socket: Socket;
  x: number;
  y: number;
  d: number;
  ts: number[];
}

async function regOrLogin(socket: Socket, username: string): Promise<{ token: string; character: any }> {
  return new Promise((resolve, reject) => {
    socket.emit('auth.register', { username, password: 'load_test_pwd_123' }, (resp: any) => {
      if (resp && resp.ok) return resolve(resp.data);
      // probably exists, try login
      socket.emit('auth.login', { username, password: 'load_test_pwd_123' }, (r2: any) => {
        if (r2 && r2.ok) return resolve(r2.data);
        reject(new Error('login/register failed: ' + JSON.stringify(r2 && r2.error)));
      });
    });
  });
}

async function spawn(args: Args, id: number): Promise<Fake> {
  const username = `bot_${id.toString().padStart(3, '0')}`;
  const sock = ioClient(args.url, { transports: ['websocket'], forceNew: true });
  await new Promise<void>((res, rej) => {
    sock.once('connect', () => res());
    sock.once('connect_error', (e) => rej(e));
  });

  const { character } = await regOrLogin(sock, username);
  // Enter map at random tile near (8,6)
  const x = (Math.floor(Math.random() * 6) + 5) | 0;
  const y = (Math.floor(Math.random() * 6) + 4) | 0;
  await new Promise<void>((res, rej) => {
    sock.emit('player.enterMap', { mapId: args.mapId, x, y, d: 2 }, (r: any) => {
      if (r && r.ok) res();
      else rej(new Error('enterMap: ' + JSON.stringify(r && r.error)));
    });
  });
  return { id, username, socket: sock, x, y, d: 2, ts: [] };
}

function randomStep(fake: Fake): void {
  const dirs = [2, 4, 6, 8];
  const d = dirs[(Math.random() * dirs.length) | 0];
  if (d === 2) fake.y = Math.min(40, fake.y + 1);
  else if (d === 8) fake.y = Math.max(0, fake.y - 1);
  else if (d === 4) fake.x = Math.max(0, fake.x - 1);
  else if (d === 6) fake.x = Math.min(40, fake.x + 1);
  fake.d = d;
  const t0 = Date.now();
  fake.socket.emit('player.move', { x: fake.x, y: fake.y, d: fake.d, ts: t0 });
  fake.ts.push(t0);
  if (fake.ts.length > 200) fake.ts.shift();
}

async function main() {
  const args = parseArgs();
  console.log('[loadtest] spawning', args.players, 'players against', args.url);
  const fakes: Fake[] = [];
  let received = 0;
  for (let i = 0; i < args.players; i++) {
    try {
      const f = await spawn(args, i);
      f.socket.on('world.delta', () => { received++; });
      fakes.push(f);
      if (i % 10 === 9) console.log('[loadtest]   spawned', i + 1, '/', args.players);
    } catch (e) {
      console.error('[loadtest] spawn fail', i, e);
    }
  }
  console.log('[loadtest] all spawned, starting random walk for', args.durationSec, 'sec');

  const stepInterval = setInterval(() => {
    for (const f of fakes) {
      if (Math.random() < 0.5) randomStep(f);
    }
  }, Math.round(1000 / args.moveHz));

  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, args.durationSec * 1000));

  clearInterval(stepInterval);
  const elapsed = (Date.now() - t0) / 1000;
  console.log('[loadtest] done. elapsed=' + elapsed.toFixed(1) + 's, deltas received=' + received);
  console.log('[loadtest] disconnecting...');
  for (const f of fakes) f.socket.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error('[loadtest] fatal', e);
  process.exit(1);
});
