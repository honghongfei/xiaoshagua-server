import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  spawnResource,
  tryClaim,
  resetForTest,
  snapshotForMap,
} from '../src/domain/gather/gatherService.js';
import { markOnline, markOffline, type OnlinePlayer } from '../src/domain/player/playerService.js';

function online(pid: number, x: number, y: number): OnlinePlayer {
  return {
    pid,
    accountId: pid,
    socketId: `s${pid}`,
    name: `p${pid}`,
    actorId: 1,
    mapId: 1,
    x,
    y,
    d: 2,
    charSet: null,
    charIndex: 0,
    level: 1,
    lastActAt: Date.now(),
  };
}

describe('gatherService', () => {
  beforeEach(() => {
    resetForTest();
  });
  afterEach(() => {
    markOffline('s1');
    markOffline('s2');
  });

  it('two pets racing the same node: only the first wins', () => {
    markOnline(online(1, 1, 1));
    markOnline(online(2, 1, 1));
    const rid = spawnResource(1, 1, 1, 7);
    const r1 = tryClaim(1, rid);
    const r2 = tryClaim(2, rid);
    expect(r1.ok).toBe(true);
    expect(r1.grant).toEqual({ characterId: 1, itemId: 7, qty: 1 });
    expect(r2).toEqual({ ok: false, code: 'CLAIMED_BY_OTHER' });
  });

  it('rejects out-of-range claim', () => {
    markOnline(online(1, 50, 50));
    const rid = spawnResource(1, 1, 1, 7);
    expect(tryClaim(1, rid)).toEqual({ ok: false, code: 'OUT_OF_RANGE' });
  });

  it('claimed node leaves snapshot', () => {
    markOnline(online(1, 1, 1));
    const rid = spawnResource(1, 1, 1, 7);
    expect(snapshotForMap(1).length).toBe(1);
    tryClaim(1, rid);
    expect(snapshotForMap(1).length).toBe(0);
  });

  it('claim succeeds when pet(follower) is in range even if owner is far', () => {
    const p = online(1, 50, 50);
    p.followers = [{ x: 1, y: 1, d: 2 }];
    markOnline(p);
    const rid = spawnResource(1, 1, 1, 7);
    expect(tryClaim(1, rid).ok).toBe(true);
  });
});
