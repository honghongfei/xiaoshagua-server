import type { Server } from 'socket.io';
import { config } from '../../config.js';
import { log } from '../../log.js';
import { AppError } from '../../util/errors.js';
import {
  getOnlineByPid,
  listOnline,
  persistPosition,
  pruneExpiredTokens,
  type OnlinePlayer,
  type FollowerView,
} from '../player/playerService.js';
import { MapState, toView } from './mapState.js';

const maps = new Map<number, MapState>();
let io: Server | null = null;
let tickHandle: NodeJS.Timeout | null = null;
let persistHandle: NodeJS.Timeout | null = null;
let tokenPruneHandle: NodeJS.Timeout | null = null;

export function attachIo(server: Server): void {
  io = server;
}

export function startTick(): void {
  if (tickHandle) return;
  tickHandle = setInterval(flushAll, config.worldTickMs);
  persistHandle = setInterval(flushPositions, 60_000);
  if (config.tokenPruneIntervalMs > 0) {
    pruneTokens();
    tokenPruneHandle = setInterval(pruneTokens, config.tokenPruneIntervalMs);
  }
  log.info({ tickMs: config.worldTickMs }, 'world tick started');
}

export function stopTick(): void {
  if (tickHandle) clearInterval(tickHandle);
  if (persistHandle) clearInterval(persistHandle);
  if (tokenPruneHandle) clearInterval(tokenPruneHandle);
  tickHandle = null;
  persistHandle = null;
  tokenPruneHandle = null;
}

function pruneTokens(): void {
  try {
    const n = pruneExpiredTokens();
    if (n > 0) log.info({ count: n }, 'expired auth tokens pruned');
  } catch (err) {
    log.warn({ err }, 'pruneExpiredTokens failed');
  }
}

function getOrCreate(mapId: number): MapState {
  let m = maps.get(mapId);
  if (!m) {
    m = new MapState(mapId);
    maps.set(mapId, m);
  }
  return m;
}

export function room(mapId: number): string {
  return `map:${mapId}`;
}

export function enterMap(
  player: OnlinePlayer,
  mapId: number,
  x: number,
  y: number,
  d: number,
): { snapshot: { mapId: number; others: ReturnType<MapState['snapshotFor']> } } {
  // M14 修：双重防护——即使外部已经把 player.mapId 改成 input.mapId，
  // 我们也兜底扫一遍所有 maps，把这个 pid 从其它 map.players 里清掉，避免泄漏。
  if (player.mapId && player.mapId !== mapId) {
    leaveMap(player.pid, player.mapId);
  }
  for (const m of maps.values()) {
    if (m.mapId !== mapId && m.players.has(player.pid)) {
      m.remove(player.pid);
      const sock = io?.sockets.sockets.get(player.socketId);
      if (sock) sock.leave(room(m.mapId));
    }
  }

  const map = getOrCreate(mapId);
  if (map.size() >= config.maxPlayersPerMap && !map.players.has(player.pid)) {
    throw new AppError('MAP_FULL', 'map is full');
  }

  player.mapId = mapId;
  player.x = x;
  player.y = y;
  player.d = d;
  player.lastActAt = Date.now();

  map.add(player);

  const socket = io?.sockets.sockets.get(player.socketId);
  if (socket) {
    socket.join(room(mapId));
    // M7 修：每个 socket 进入 'world' room, 让 chatService 的世界频道单次 emit
    socket.join('world');
  }

  return {
    snapshot: { mapId, others: map.snapshotFor(player.pid) },
  };
}

export function leaveMap(pid: number, mapId: number): void {
  const map = maps.get(mapId);
  if (!map) return;
  const p = map.remove(pid);
  if (p) {
    const sock = io?.sockets.sockets.get(p.socketId);
    if (sock) sock.leave(room(mapId));
  }
  if (map.size() === 0) {
    flushOne(map);
  }
}

export function moveOnMap(
  pid: number,
  x: number,
  y: number,
  d: number,
  followers?: FollowerView[],
): boolean {
  const p = getOnlineByPid(pid);
  if (!p) return false;
  const map = maps.get(p.mapId);
  if (!map) return false;
  return map.applyMove(pid, x, y, d, followers);
}

export function actOnMap(pid: number, type: string): boolean {
  const p = getOnlineByPid(pid);
  if (!p) return false;
  const map = maps.get(p.mapId);
  if (!map) return false;
  return map.applyAction(pid, type);
}

function flushAll(): void {
  if (!io) return;
  for (const map of maps.values()) {
    flushOne(map);
  }
}

function flushOne(map: MapState): void {
  if (!io) return;
  const delta = map.drainDelta();
  if (!delta) return;

  const payload = {
    seq: ++map.seq,
    enter: delta.enter.map(toView),
    leave: delta.leave,
    move: Array.from(delta.move.values()),
    action: delta.action,
  };

  io.to(room(map.mapId)).emit('world.delta', payload);
}

export function flushPositions(): void {
  let n = 0;
  for (const p of listOnline()) {
    try {
      persistPosition(p);
      n++;
    } catch (err) {
      log.warn({ err, pid: p.pid }, 'persistPosition failed');
    }
  }
  if (n > 0) log.debug({ count: n }, 'positions flushed');
}

export function stats(): { maps: number; players: number } {
  let total = 0;
  for (const m of maps.values()) total += m.size();
  return { maps: maps.size, players: total };
}
