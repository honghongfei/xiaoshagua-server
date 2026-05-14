import type { Server } from 'socket.io';
import { openDb } from '../../db/sqlite.js';
import { log } from '../../log.js';
import { AppError } from '../../util/errors.js';

interface SwitchRow { id: number; value: number; updated_at: number; }
interface VarRow { id: number; value: number; updated_at: number; }

let io: Server | null = null;
export function attachStateIo(server: Server): void {
  io = server;
}

// H6 修：共享状态白名单。
// 默认空 set = 拒绝所有写入 (生产环境必须显式列出共享 id);
// 通过 .env 的 SHARED_SWITCH_IDS / SHARED_VARIABLE_IDS 配置。
function parseIdList(s: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!s) return out;
  for (const part of s.split(',')) {
    const v = Number(part.trim());
    if (Number.isInteger(v) && v > 0) out.add(v);
  }
  return out;
}
const allowedSwitches = parseIdList(process.env.SHARED_SWITCH_IDS);
const allowedVariables = parseIdList(process.env.SHARED_VARIABLE_IDS);
log.info({ allowedSwitches: Array.from(allowedSwitches), allowedVariables: Array.from(allowedVariables) }, 'state allowlist loaded');

export function assertSwitchAllowed(id: number): void {
  if (!allowedSwitches.has(id)) {
    throw new AppError('FORBIDDEN', `switch id ${id} not in shared allowlist`);
  }
}

export function assertVariableAllowed(id: number): void {
  if (!allowedVariables.has(id)) {
    throw new AppError('FORBIDDEN', `variable id ${id} not in shared allowlist`);
  }
}

// In-memory cache of shared state; loaded once on first read.
const swCache = new Map<number, number>();
const varCache = new Map<number, number>();
let swLoaded = false;
let varLoaded = false;

function ensureSwitches(): void {
  if (swLoaded) return;
  const db = openDb();
  const rows = db.prepare<[], SwitchRow>('SELECT id, value, updated_at FROM shared_switches').all();
  for (const r of rows) swCache.set(r.id, r.value);
  swLoaded = true;
  log.info({ count: rows.length }, 'shared switches loaded');
}

function ensureVars(): void {
  if (varLoaded) return;
  const db = openDb();
  const rows = db.prepare<[], VarRow>('SELECT id, value, updated_at FROM shared_variables').all();
  for (const r of rows) varCache.set(r.id, r.value);
  varLoaded = true;
  log.info({ count: rows.length }, 'shared variables loaded');
}

export function snapshotShared(): { switches: { id: number; value: number }[]; vars: { id: number; value: number }[] } {
  ensureSwitches();
  ensureVars();
  return {
    switches: Array.from(swCache.entries()).map(([id, value]) => ({ id, value })),
    vars: Array.from(varCache.entries()).map(([id, value]) => ({ id, value })),
  };
}

export function setSharedSwitch(id: number, value: 0 | 1): boolean {
  ensureSwitches();
  const cur = swCache.get(id);
  if (cur === value) return false;
  swCache.set(id, value);
  const db = openDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO shared_switches (id, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(id, value, now);
  if (io) io.emit('state.switchEvt', { id, value, ts: now });
  return true;
}

export function setSharedVariable(id: number, value: number): boolean {
  ensureVars();
  const cur = varCache.get(id);
  if (cur === value) return false;
  varCache.set(id, value);
  const db = openDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO shared_variables (id, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(id, value, now);
  if (io) io.emit('state.varEvt', { id, value, ts: now });
  return true;
}

export function getSharedSwitch(id: number): number {
  ensureSwitches();
  return swCache.get(id) ?? 0;
}

export function getSharedVariable(id: number): number {
  ensureVars();
  return varCache.get(id) ?? 0;
}
