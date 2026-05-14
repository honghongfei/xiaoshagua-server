import type { Server } from 'socket.io';
import { openDb } from '../../db/sqlite.js';
import { log } from '../../log.js';

interface SwitchRow { id: number; value: number; updated_at: number; }
interface VarRow { id: number; value: number; updated_at: number; }

let io: Server | null = null;
export function attachStateIo(server: Server): void {
  io = server;
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
