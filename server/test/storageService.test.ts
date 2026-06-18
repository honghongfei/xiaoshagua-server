// 存档锁账号：assertSaveOwner 纯函数校验（不碰 DB）。
// 规则：存档 contents 里若带 xsgOwner.pid 且 != 上传者 characterId → 抛 SAVE_FOREIGN；
//       无章 / 非法 JSON / pid 非数字 → fail-open 放行（不误伤老档与脏数据）。
import { describe, it, expect } from 'vitest';
import { assertSaveOwner } from '../src/domain/storage/storageService.js';

function withOwner(pid: unknown): string {
  return JSON.stringify({ xsgOwner: { v: 1, pid, accountId: pid, at: 1 }, party: { _gold: 100 } });
}

describe('assertSaveOwner (save-account lock)', () => {
  it('passes when save owner pid matches the uploader characterId', () => {
    expect(() => assertSaveOwner(withOwner(5), 5)).not.toThrow();
  });

  it('rejects with SAVE_FOREIGN when owner pid differs from uploader', () => {
    let code: string | undefined;
    try {
      assertSaveOwner(withOwner(7), 5);
    } catch (e: any) {
      code = e?.code;
    }
    expect(code).toBe('SAVE_FOREIGN');
  });

  it('passes (legacy compat) when save has no xsgOwner', () => {
    const legacy = JSON.stringify({ party: { _gold: 100 } });
    expect(() => assertSaveOwner(legacy, 5)).not.toThrow();
  });

  it('fail-open: passes when contents is not valid JSON', () => {
    expect(() => assertSaveOwner('{not json', 5)).not.toThrow();
  });

  it('does not false-reject when xsgOwner.pid is not a number (dirty data)', () => {
    expect(() => assertSaveOwner(withOwner('abc'), 5)).not.toThrow();
  });
});
