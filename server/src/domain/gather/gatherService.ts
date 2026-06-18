// 地上物云端共享：服务端权威资源层。spawn/respawn 调度 + claim 仲裁 + gather.delta 广播。
// 复用 world 的 room(mapId) 分图广播；不依赖 inventory(由 router 在 claim 成功后发货, 便于单测)。
import type { Server } from 'socket.io';
import { config } from '../../config.js';
import { getOnlineByPid } from '../player/playerService.js';
import { room } from '../world/worldService.js';
import { ResourceState, type ResourceNode } from './resourceState.js';
import { loadSpawnTable, getSpawnTable, slotsForMap } from './spawnTable.js';

const states = new Map<number, ResourceState>();
let io: Server | null = null;
let tick: NodeJS.Timeout | null = null;
let ridSeq = 1;
// 每槽位下次可生成时间(计时从"被采"起算)：key=`${mapId}:${x}:${y}`
const nextSpawnAt = new Map<string, number>();

export function attachGatherIo(s: Server): void {
  io = s;
  loadSpawnTable();
}

export function startGatherTick(): void {
  if (tick) return;
  const ms = config.gatherTickMs > 0 ? config.gatherTickMs : config.worldTickMs;
  tick = setInterval(gatherTick, ms);
}

export function stopGatherTick(): void {
  if (tick) {
    clearInterval(tick);
    tick = null;
  }
}

function stateOf(mapId: number): ResourceState {
  let st = states.get(mapId);
  if (!st) {
    st = new ResourceState(mapId);
    states.set(mapId, st);
  }
  return st;
}

export function snapshotForMap(mapId: number): ReturnType<ResourceState['snapshot']> {
  return stateOf(mapId).snapshot();
}

// 该图是否由服务端权威管理(槽位表里有该图) → 客户端据此决定是否接管资源可见性
export function isMapManaged(mapId: number): boolean {
  const slots = getSpawnTable()[mapId];
  return Array.isArray(slots) && slots.length > 0;
}

export function spawnResource(
  mapId: number,
  x: number,
  y: number,
  itemId: number,
  respawnMs?: number,
): number {
  const rid = ridSeq++;
  stateOf(mapId).spawn({
    rid,
    x,
    y,
    itemId,
    kind: 'item',
    state: 'active',
    respawnMs: respawnMs ?? config.gatherDefaultRespawnMs,
  });
  return rid;
}

function slotKey(mapId: number, x: number, y: number): string {
  return `${mapId}:${x}:${y}`;
}

function gatherTick(): void {
  if (!io) return;
  const now = Date.now();
  const table = getSpawnTable();
  for (const mapIdStr of Object.keys(table)) {
    const mapId = Number(mapIdStr);
    const st = stateOf(mapId);
    for (const slot of slotsForMap(mapId)) {
      if (st.hasActiveAt(slot.x, slot.y)) continue;
      if (now < (nextSpawnAt.get(slotKey(mapId, slot.x, slot.y)) ?? 0)) continue;
      spawnResource(mapId, slot.x, slot.y, slot.itemId, slot.respawnMs);
    }
  }
  for (const st of states.values()) flushOne(st);
}

function flushOne(st: ResourceState): void {
  if (!io) return;
  const d = st.drainDelta();
  if (!d) return;
  io.to(room(st.mapId)).emit('gather.delta', {
    seq: ++st.seq,
    spawn: d.spawn,
    claimed: d.claimed,
  });
}

export interface ClaimGrant {
  characterId: number;
  itemId: number;
  qty: number;
}

export interface ClaimResult {
  ok: boolean;
  code?: string;
  grant?: ClaimGrant;
}

export function tryClaim(pid: number, rid: number): ClaimResult {
  const p = getOnlineByPid(pid);
  if (!p) return { ok: false, code: 'NO_AUTH' };
  const st = states.get(p.mapId);
  if (!st) return { ok: false, code: 'NO_SUCH_NODE' };
  const node = st.nodes.get(rid);
  if (!node || node.state !== 'active') return { ok: false, code: 'CLAIMED_BY_OTHER' };
  if (!inRange(p, node)) return { ok: false, code: 'OUT_OF_RANGE' };
  const claimed = st.claim(rid, pid);
  if (!claimed) return { ok: false, code: 'CLAIMED_BY_OTHER' };
  // 计时从"被采"起算：该槽位 respawnMs 之后才重生(默认 30 分钟)
  nextSpawnAt.set(slotKey(p.mapId, node.x, node.y), Date.now() + node.respawnMs);
  st.remove(rid);
  return { ok: true, grant: { characterId: p.pid, itemId: node.itemId, qty: 1 } };
}

function inRange(
  p: { x: number; y: number; followers?: { x: number; y: number }[] },
  node: ResourceNode,
): boolean {
  const r = config.gatherClaimRangeTiles;
  const near = (ax: number, ay: number) => Math.abs(ax - node.x) <= r && Math.abs(ay - node.y) <= r;
  if (near(p.x, p.y)) return true;
  for (const f of p.followers ?? []) {
    if (near(f.x, f.y)) return true; // 宝宝(follower)在范围内也算
  }
  return false;
}

// 测试用：清空内部状态
export function resetForTest(): void {
  states.clear();
  nextSpawnAt.clear();
  ridSeq = 1;
}
