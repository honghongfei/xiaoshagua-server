import type { OnlinePlayer } from '../player/playerService.js';

export interface MoveDelta {
  pid: number;
  x: number;
  y: number;
  d: number;
}

export interface ActionEvent {
  pid: number;
  type: string;
}

export interface PendingDelta {
  enter: OnlinePlayer[];
  leave: number[];
  move: Map<number, MoveDelta>;
  action: ActionEvent[];
}

export interface RemotePlayerView {
  pid: number;
  name: string;
  actorId: number;
  x: number;
  y: number;
  d: number;
  charSet: string | null;
  charIndex: number;
  level: number;
}

export function toView(p: OnlinePlayer): RemotePlayerView {
  return {
    pid: p.pid,
    name: p.name,
    actorId: p.actorId,
    x: p.x,
    y: p.y,
    d: p.d,
    charSet: p.charSet,
    charIndex: p.charIndex,
    level: p.level,
  };
}

export class MapState {
  readonly mapId: number;
  readonly players = new Map<number, OnlinePlayer>();
  private pending: PendingDelta = freshDelta();
  seq = 0;

  constructor(mapId: number) {
    this.mapId = mapId;
  }

  add(p: OnlinePlayer): void {
    this.players.set(p.pid, p);
    this.pending.enter.push(p);
    this.pending.leave = this.pending.leave.filter((id) => id !== p.pid);
  }

  remove(pid: number): OnlinePlayer | undefined {
    const p = this.players.get(pid);
    this.players.delete(pid);
    this.pending.enter = this.pending.enter.filter((e) => e.pid !== pid);
    this.pending.move.delete(pid);
    if (p) this.pending.leave.push(pid);
    return p;
  }

  applyMove(pid: number, x: number, y: number, d: number): boolean {
    const p = this.players.get(pid);
    if (!p) return false;
    if (p.x === x && p.y === y && p.d === d) return false;
    p.x = x;
    p.y = y;
    p.d = d;
    p.lastActAt = Date.now();
    this.pending.move.set(pid, { pid, x, y, d });
    return true;
  }

  applyAction(pid: number, type: string): boolean {
    if (!this.players.has(pid)) return false;
    this.pending.action.push({ pid, type });
    return true;
  }

  drainDelta(): PendingDelta | null {
    const d = this.pending;
    if (d.enter.length === 0 && d.leave.length === 0 && d.move.size === 0 && d.action.length === 0) {
      return null;
    }
    this.pending = freshDelta();
    return d;
  }

  snapshotFor(viewerPid: number): RemotePlayerView[] {
    const out: RemotePlayerView[] = [];
    for (const p of this.players.values()) {
      if (p.pid === viewerPid) continue;
      out.push(toView(p));
    }
    return out;
  }

  size(): number {
    return this.players.size;
  }
}

function freshDelta(): PendingDelta {
  return { enter: [], leave: [], move: new Map(), action: [] };
}
