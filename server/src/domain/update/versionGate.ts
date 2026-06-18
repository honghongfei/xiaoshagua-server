import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../util/errors.js';
import { log } from '../../log.js';

// 与 updateRoute 同一发布目录; manifest.minVersion 控制"真·强制更新"。
const RELEASES_DIR = path.resolve(process.env.RELEASES_DIR || './releases');
const CACHE_MS = 15_000;

let cache: { minVersion: string; latest: string; at: number } | null = null;

function loadGate(): { minVersion: string; latest: string } {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache;
  let minVersion = '0.0.0';
  let latest = '0.0.0';
  try {
    const o = JSON.parse(fs.readFileSync(path.join(RELEASES_DIR, 'manifest.json'), 'utf8'));
    if (o && typeof o.minVersion === 'string') minVersion = o.minVersion;
    if (o && typeof o.latest === 'string') latest = o.latest;
  } catch {
    // 没有 manifest -> 视为未开启强制
  }
  cache = { minVersion, latest, at: now };
  return cache;
}

function cmpVer(a: string, b: string): number {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 登录版本拦截（真·强制更新）。
 * - manifest.minVersion 为 '0.0.0'（默认）时不拦截任何客户端，零影响。
 * - 一旦把 minVersion 提到某版本，低于它的客户端（含不带 clientVer 的老客户端）登录被拒，
 *   客户端收到 VERSION_TOO_LOW 后弹强制更新窗。
 */
export function assertClientVersion(clientVer?: string): void {
  const { minVersion, latest } = loadGate();
  if (!minVersion || minVersion === '0.0.0') return;
  const cv = clientVer || '0.0.0';
  if (cmpVer(cv, minVersion) < 0) {
    log.info({ clientVer: cv, minVersion }, 'login rejected: client version too low');
    throw new AppError(
      'VERSION_TOO_LOW',
      `客户端版本过低（需 ≥ ${minVersion}，最新 ${latest}），请更新后再登录`,
      426,
    );
  }
}
