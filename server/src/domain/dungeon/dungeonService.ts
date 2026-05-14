import type { Server } from 'socket.io';
import { AppError } from '../../util/errors.js';
import { newShortId } from '../../util/ids.js';
import { log } from '../../log.js';
import { getOnlineByPid, type OnlinePlayer } from '../player/playerService.js';

// Virtual map ids start at 10_000_000 to avoid clashing real maps.
const VIRTUAL_BASE = 10_000_000;
let vCounter = 1;

interface Instance {
  instanceId: string;
  virtualMapId: number;
  baseMapId: number;
  dungeonId: string;
  ownerPid: number;
  partyPids: Set<number>;
  createdAt: number;
}

const instances = new Map<string, Instance>();
const pidToInstance = new Map<number, string>();
let io: Server | null = null;

export function attachDungeonIo(server: Server): void { io = server; }

export interface DungeonDef {
  baseMapId: number;
  spawnX: number;
  spawnY: number;
  spawnD: number;
}

// Demo registry — in v1 these are hard-coded; future: load from rules/*.json
const DUNGEON_DEFS: Record<string, DungeonDef> = {
  test_cave: { baseMapId: 1, spawnX: 8, spawnY: 6, spawnD: 2 },
};

export interface EnterResult {
  instanceId: string;
  virtualMapId: number;
  baseMapId: number;
  spawn: { x: number; y: number; d: number };
  party: number[];
}

export function enter(ownerPid: number, dungeonId: string, partyPids: number[] = []): EnterResult {
  const def = DUNGEON_DEFS[dungeonId];
  if (!def) throw new AppError('NOT_FOUND', 'unknown dungeon: ' + dungeonId);
  const allPids = new Set<number>([ownerPid, ...partyPids]);
  for (const pid of allPids) {
    if (pidToInstance.has(pid)) throw new AppError('IN_INSTANCE', 'someone already in instance');
    const p = getOnlineByPid(pid);
    if (!p) throw new AppError('OFFLINE', 'party member offline: ' + pid);
  }

  const instanceId = newShortId();
  const virtualMapId = VIRTUAL_BASE + vCounter++;
  const inst: Instance = {
    instanceId,
    virtualMapId,
    baseMapId: def.baseMapId,
    dungeonId,
    ownerPid,
    partyPids: allPids,
    createdAt: Date.now(),
  };
  instances.set(instanceId, inst);
  for (const pid of allPids) pidToInstance.set(pid, instanceId);

  if (io) {
    for (const pid of allPids) {
      const p = getOnlineByPid(pid);
      if (p) {
        io.to(p.socketId).emit('dungeon.enter.evt', {
          instanceId,
          virtualMapId,
          baseMapId: def.baseMapId,
          spawn: { x: def.spawnX, y: def.spawnY, d: def.spawnD },
          party: Array.from(allPids),
        });
      }
    }
  }

  log.info({ instanceId, virtualMapId, dungeonId, party: Array.from(allPids) }, 'dungeon entered');

  return {
    instanceId,
    virtualMapId,
    baseMapId: def.baseMapId,
    spawn: { x: def.spawnX, y: def.spawnY, d: def.spawnD },
    party: Array.from(allPids),
  };
}

export function leave(pid: number): void {
  const id = pidToInstance.get(pid);
  if (!id) return;
  const inst = instances.get(id);
  pidToInstance.delete(pid);
  if (inst) {
    inst.partyPids.delete(pid);
    if (io) {
      const p = getOnlineByPid(pid);
      if (p) io.to(p.socketId).emit('dungeon.leave.evt', { instanceId: id });
      // notify remaining party
      for (const otherPid of inst.partyPids) {
        const op = getOnlineByPid(otherPid);
        if (op) io.to(op.socketId).emit('dungeon.peerLeft.evt', { instanceId: id, pid });
      }
    }
    if (inst.partyPids.size === 0) {
      instances.delete(id);
      log.info({ instanceId: id }, 'dungeon disposed');
    }
  }
}

export function onPlayerDisconnect(pid: number): void {
  leave(pid);
}

export function listInstancesForDebug(): { instanceId: string; dungeonId: string; party: number[] }[] {
  return Array.from(instances.values()).map((i) => ({
    instanceId: i.instanceId,
    dungeonId: i.dungeonId,
    party: Array.from(i.partyPids),
  }));
}

export function isInInstance(pid: number): string | undefined {
  return pidToInstance.get(pid);
}

export function _resolvePlayerInstance(p: OnlinePlayer): Instance | undefined {
  const id = pidToInstance.get(p.pid);
  return id ? instances.get(id) : undefined;
}
