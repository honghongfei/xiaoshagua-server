import { describe, it, expect } from 'vitest';
import { ResourceState, type ResourceNode } from '../src/domain/gather/resourceState.js';

function node(rid: number, x = 1, y = 1): ResourceNode {
  return { rid, x, y, itemId: 7, kind: 'item', state: 'active', respawnMs: 1_800_000 };
}

describe('ResourceState', () => {
  it('spawn shows in snapshot', () => {
    const s = new ResourceState(1);
    s.spawn(node(1));
    expect(s.snapshot()).toEqual([{ rid: 1, x: 1, y: 1, itemId: 7 }]);
  });

  it('claim active returns node; second claim returns null', () => {
    const s = new ResourceState(1);
    s.spawn(node(1));
    expect(s.claim(1, 100)).not.toBeNull();
    expect(s.claim(1, 200)).toBeNull();
  });

  it('claimed node leaves snapshot and hasActiveAt', () => {
    const s = new ResourceState(1);
    s.spawn(node(1, 3, 4));
    expect(s.hasActiveAt(3, 4)).toBe(true);
    s.claim(1, 100);
    expect(s.snapshot()).toEqual([]);
    expect(s.hasActiveAt(3, 4)).toBe(false);
  });

  it('drainDelta accumulates spawn+claimed then clears', () => {
    const s = new ResourceState(1);
    s.spawn(node(1));
    s.claim(1, 100);
    const d = s.drainDelta()!;
    expect(d.spawn).toEqual([{ rid: 1, x: 1, y: 1, itemId: 7 }]);
    expect(d.claimed).toEqual([{ rid: 1, byPid: 100 }]);
    expect(s.drainDelta()).toBeNull();
  });
});
