// 每图地上资源态 + 增量(spawn/claimed) 累积器。镜像 world/mapState 的 delta 模式。
export interface ResourceNode {
  rid: number;
  x: number;
  y: number;
  itemId: number;
  kind: 'item';
  state: 'active' | 'claimed';
  respawnMs: number;
}

export interface ResourceSpawnView {
  rid: number;
  x: number;
  y: number;
  itemId: number;
}

export interface ResourceClaimView {
  rid: number;
  byPid: number;
}

interface PendingResDelta {
  spawn: ResourceSpawnView[];
  claimed: ResourceClaimView[];
}

export class ResourceState {
  readonly mapId: number;
  readonly nodes = new Map<number, ResourceNode>();
  private pending: PendingResDelta = freshDelta();
  seq = 0;

  constructor(mapId: number) {
    this.mapId = mapId;
  }

  spawn(node: ResourceNode): void {
    this.nodes.set(node.rid, node);
    this.pending.spawn.push({ rid: node.rid, x: node.x, y: node.y, itemId: node.itemId });
  }

  // 认领成功返回被认领的 node(供发货)，失败(不存在/已被领) 返回 null。
  claim(rid: number, byPid: number): ResourceNode | null {
    const n = this.nodes.get(rid);
    if (!n || n.state !== 'active') return null;
    n.state = 'claimed';
    this.pending.claimed.push({ rid, byPid });
    return n;
  }

  remove(rid: number): void {
    this.nodes.delete(rid);
  }

  hasActiveAt(x: number, y: number): boolean {
    for (const n of this.nodes.values()) {
      if (n.state === 'active' && n.x === x && n.y === y) return true;
    }
    return false;
  }

  drainDelta(): PendingResDelta | null {
    const d = this.pending;
    if (d.spawn.length === 0 && d.claimed.length === 0) return null;
    this.pending = freshDelta();
    return d;
  }

  snapshot(): ResourceSpawnView[] {
    const out: ResourceSpawnView[] = [];
    for (const n of this.nodes.values()) {
      if (n.state === 'active') out.push({ rid: n.rid, x: n.x, y: n.y, itemId: n.itemId });
    }
    return out;
  }
}

function freshDelta(): PendingResDelta {
  return { spawn: [], claimed: [] };
}
