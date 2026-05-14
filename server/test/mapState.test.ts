import { describe, it, expect } from 'vitest';
import { MapState } from '../src/domain/world/mapState.js';
import type { OnlinePlayer } from '../src/domain/player/playerService.js';

function mkPlayer(pid: number, name = `p${pid}`): OnlinePlayer {
  return {
    pid,
    accountId: pid,
    socketId: `sock-${pid}`,
    name,
    actorId: 1,
    mapId: 1,
    x: 0,
    y: 0,
    d: 2,
    charSet: null,
    charIndex: 0,
    level: 1,
    lastActAt: Date.now(),
  };
}

describe('MapState', () => {
  it('add / remove track players', () => {
    const m = new MapState(1);
    expect(m.size()).toBe(0);
    m.add(mkPlayer(1));
    m.add(mkPlayer(2));
    expect(m.size()).toBe(2);
    m.remove(1);
    expect(m.size()).toBe(1);
  });

  it('snapshotFor excludes viewer', () => {
    const m = new MapState(1);
    m.add(mkPlayer(1, 'a'));
    m.add(mkPlayer(2, 'b'));
    m.add(mkPlayer(3, 'c'));
    const snap = m.snapshotFor(2);
    expect(snap.map((p) => p.pid).sort()).toEqual([1, 3]);
    expect(snap.find((p) => p.pid === 2)).toBeUndefined();
  });

  it('applyMove returns false for unknown pid', () => {
    const m = new MapState(1);
    expect(m.applyMove(99, 1, 1, 4)).toBe(false);
  });

  it('applyMove ignores no-op', () => {
    const m = new MapState(1);
    const p = mkPlayer(1);
    m.add(p);
    m.drainDelta();
    expect(m.applyMove(1, 0, 0, 2)).toBe(false);
    expect(m.drainDelta()).toBeNull();
  });

  it('drainDelta returns enter+move+leave then clears', () => {
    const m = new MapState(1);
    m.add(mkPlayer(1));
    m.add(mkPlayer(2));
    m.applyMove(1, 3, 4, 6);
    m.applyAction(2, 'wave');
    m.remove(2);

    const d = m.drainDelta();
    expect(d).not.toBeNull();
    expect(d!.enter.map((p) => p.pid)).toEqual([1]);
    expect(d!.leave).toEqual([2]);
    expect(Array.from(d!.move.values())).toEqual([{ pid: 1, x: 3, y: 4, d: 6 }]);
    expect(d!.action).toEqual([{ pid: 2, type: 'wave' }]);

    expect(m.drainDelta()).toBeNull();
  });

  it('latest move overrides earlier ones in same tick', () => {
    const m = new MapState(1);
    m.add(mkPlayer(1));
    m.drainDelta();
    m.applyMove(1, 1, 0, 6);
    m.applyMove(1, 2, 0, 6);
    m.applyMove(1, 3, 0, 6);
    const d = m.drainDelta();
    expect(d).not.toBeNull();
    expect(d!.move.get(1)).toEqual({ pid: 1, x: 3, y: 0, d: 6 });
  });

  it('remove cancels pending enter in same tick', () => {
    const m = new MapState(1);
    m.add(mkPlayer(7));
    m.remove(7);
    const d = m.drainDelta();
    expect(d).not.toBeNull();
    expect(d!.enter).toEqual([]);
    expect(d!.leave).toEqual([7]);
  });
});
