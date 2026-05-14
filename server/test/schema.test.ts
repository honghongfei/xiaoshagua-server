import { describe, it, expect } from 'vitest';
import {
  AuthLogin,
  AuthRegister,
  PlayerEnterMap,
  PlayerMove,
  PlayerAction,
} from '../src/util/schema.js';

describe('AuthLogin', () => {
  it('accepts a clean payload', () => {
    const r = AuthLogin.safeParse({ username: 'alice', password: 'pa55word' });
    expect(r.success).toBe(true);
  });

  it('rejects short username', () => {
    const r = AuthLogin.safeParse({ username: 'ab', password: 'pa55word' });
    expect(r.success).toBe(false);
  });

  it('rejects bad chars in username', () => {
    const r = AuthLogin.safeParse({ username: 'a b!', password: 'pa55word' });
    expect(r.success).toBe(false);
  });

  it('accepts CJK username', () => {
    const r = AuthLogin.safeParse({ username: '小傻瓜', password: 'pa55word' });
    expect(r.success).toBe(true);
  });
});

describe('AuthRegister', () => {
  it('allows omitting optional fields', () => {
    const r = AuthRegister.safeParse({ username: 'bob', password: 'secret1' });
    expect(r.success).toBe(true);
  });

  it('clamps actorId range', () => {
    const ok = AuthRegister.safeParse({ username: 'bob', password: 'secret1', actorId: 1 });
    const bad = AuthRegister.safeParse({ username: 'bob', password: 'secret1', actorId: 0 });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });
});

describe('PlayerEnterMap / PlayerMove', () => {
  it('accepts d in {2,4,6,8}', () => {
    for (const d of [2, 4, 6, 8]) {
      expect(PlayerEnterMap.safeParse({ mapId: 1, x: 0, y: 0, d }).success).toBe(true);
      expect(PlayerMove.safeParse({ x: 0, y: 0, d }).success).toBe(true);
    }
  });

  it('rejects d=5 (diagonal not allowed)', () => {
    expect(PlayerEnterMap.safeParse({ mapId: 1, x: 0, y: 0, d: 5 }).success).toBe(false);
    expect(PlayerMove.safeParse({ x: 0, y: 0, d: 5 }).success).toBe(false);
  });

  it('rejects out-of-range coords', () => {
    expect(PlayerEnterMap.safeParse({ mapId: 1, x: 1000, y: 0, d: 2 }).success).toBe(false);
    expect(PlayerEnterMap.safeParse({ mapId: 1, x: -1, y: 0, d: 2 }).success).toBe(false);
  });
});

describe('PlayerAction', () => {
  it('limits type length', () => {
    expect(PlayerAction.safeParse({ type: 'wave' }).success).toBe(true);
    expect(PlayerAction.safeParse({ type: '' }).success).toBe(false);
    expect(PlayerAction.safeParse({ type: 'x'.repeat(25) }).success).toBe(false);
  });
});
