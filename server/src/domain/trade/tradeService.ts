import type { Server } from 'socket.io';
import { log } from '../../log.js';
import { AppError } from '../../util/errors.js';
import { newShortId } from '../../util/ids.js';
import { getOnlineByPid } from '../player/playerService.js';
import * as invRepo from '../inventory/inventoryRepo.js';

export type ItemKind = 'item' | 'weapon' | 'armor';

export interface OfferItem { kind: ItemKind; dataId: number; count: number; }
export interface OfferSide {
  pid: number;
  gold: number;
  items: OfferItem[];
  locked: boolean;
  confirmed: boolean;
}

interface Trade {
  id: string;
  a: OfferSide;
  b: OfferSide;
  state: 'invited' | 'open' | 'locked' | 'committed' | 'cancelled';
  createdAt: number;
}

const trades = new Map<string, Trade>();
const pidToTrade = new Map<number, string>();
let io: Server | null = null;

export function attachTradeIo(server: Server): void { io = server; }

export function invite(fromPid: number, targetPid: number): { tradeId: string } {
  if (fromPid === targetPid) throw new AppError('BAD_INPUT', 'cannot trade self');
  if (pidToTrade.has(fromPid) || pidToTrade.has(targetPid)) {
    throw new AppError('ALREADY_TRADING', 'one of you is already trading');
  }
  const fromP = getOnlineByPid(fromPid);
  const toP = getOnlineByPid(targetPid);
  if (!fromP || !toP) throw new AppError('OFFLINE', 'peer offline');
  const tradeId = newShortId();
  const t: Trade = {
    id: tradeId,
    a: { pid: fromPid, gold: 0, items: [], locked: false, confirmed: false },
    b: { pid: targetPid, gold: 0, items: [], locked: false, confirmed: false },
    state: 'invited',
    createdAt: Date.now(),
  };
  trades.set(tradeId, t);
  pidToTrade.set(fromPid, tradeId);
  pidToTrade.set(targetPid, tradeId);
  if (io) {
    io.to(toP.socketId).emit('trade.invite.evt', { tradeId, fromPid, fromName: fromP.name });
  }
  return { tradeId };
}

export function respond(tradeId: string, pid: number, accept: boolean): void {
  const t = trades.get(tradeId);
  if (!t) throw new AppError('NOT_FOUND', 'trade not found');
  if (t.b.pid !== pid) throw new AppError('FORBIDDEN', 'only invitee can respond');
  if (t.state !== 'invited') throw new AppError('BAD_STATE', 'already responded');
  if (!accept) {
    t.state = 'cancelled';
    end(t, 'declined');
    return;
  }
  t.state = 'open';
  notifyOpened(t);
}

function notifyOpened(t: Trade): void {
  const ap = getOnlineByPid(t.a.pid);
  const bp = getOnlineByPid(t.b.pid);
  // M4 修：如果任一端离线 / io 不可用, 不要静默 return 让交易进 zombie state。
  //         状态回滚 + 清理映射 + 通知能找到的那边。
  if (!io || !ap || !bp) {
    t.state = 'cancelled';
    end(t, ap ? 'peer_offline' : 'self_offline');
    return;
  }
  io.to(ap.socketId).emit('trade.opened.evt', { tradeId: t.id, peer: { pid: bp.pid, name: bp.name } });
  io.to(bp.socketId).emit('trade.opened.evt', { tradeId: t.id, peer: { pid: ap.pid, name: ap.name } });
}

export function setOffer(
  tradeId: string,
  pid: number,
  gold: number,
  items: OfferItem[],
): void {
  const t = trades.get(tradeId);
  if (!t) throw new AppError('NOT_FOUND', 'trade not found');
  if (t.state !== 'open' && t.state !== 'locked') throw new AppError('BAD_STATE', 'closed');
  const side = sideOf(t, pid);
  if (gold < 0) throw new AppError('BAD_INPUT', 'gold must be >=0');
  validateOwnership(pid, gold, items);
  side.gold = gold;
  side.items = items;
  // Any offer change resets locks
  t.a.locked = false;
  t.a.confirmed = false;
  t.b.locked = false;
  t.b.confirmed = false;
  if (t.state === 'locked') t.state = 'open';
  broadcastOffer(t);
}

function validateOwnership(pid: number, gold: number, items: OfferItem[]): void {
  const haveGold = invRepo.getGold(pid);
  if (haveGold < gold) throw new AppError('NOT_ENOUGH_GOLD', `need ${gold}, have ${haveGold}`);
  const cur = invRepo.listInventory(pid);
  for (const it of items) {
    const row = cur.find((r) => r.kind === it.kind && r.data_id === it.dataId);
    if (!row || row.count < it.count) {
      throw new AppError('NOT_ENOUGH_ITEM', `need ${it.count} of ${it.kind}#${it.dataId}`);
    }
  }
}

export function lock(tradeId: string, pid: number): void {
  const t = trades.get(tradeId);
  if (!t) throw new AppError('NOT_FOUND', 'trade not found');
  if (t.state !== 'open' && t.state !== 'locked') throw new AppError('BAD_STATE', 'closed');
  const side = sideOf(t, pid);
  side.locked = true;
  if (t.a.locked && t.b.locked) t.state = 'locked';
  broadcastOffer(t);
}

export function unlock(tradeId: string, pid: number): void {
  const t = trades.get(tradeId);
  if (!t) throw new AppError('NOT_FOUND', 'trade not found');
  const side = sideOf(t, pid);
  side.locked = false;
  side.confirmed = false;
  if (t.state === 'locked') t.state = 'open';
  broadcastOffer(t);
}

export function confirm(tradeId: string, pid: number): void {
  const t = trades.get(tradeId);
  if (!t) throw new AppError('NOT_FOUND', 'trade not found');
  if (t.state !== 'locked') throw new AppError('BAD_STATE', 'not locked yet');
  const side = sideOf(t, pid);
  side.confirmed = true;
  broadcastOffer(t);
  if (t.a.confirmed && t.b.confirmed) commit(t);
}

export function cancel(tradeId: string, pid: number, reason = 'cancelled'): void {
  const t = trades.get(tradeId);
  if (!t) return;
  if (t.a.pid !== pid && t.b.pid !== pid) throw new AppError('FORBIDDEN', 'not a participant');
  t.state = 'cancelled';
  end(t, reason);
}

function commit(t: Trade): void {
  invRepo.tx((db) => {
    // Re-validate ownership inside transaction
    validateOwnership(t.a.pid, t.a.gold, t.a.items);
    validateOwnership(t.b.pid, t.b.gold, t.b.items);

    if (t.a.gold > 0) invRepo.applyGoldDelta(db, t.a.pid, -t.a.gold);
    if (t.a.gold > 0) invRepo.applyGoldDelta(db, t.b.pid, t.a.gold);
    if (t.b.gold > 0) invRepo.applyGoldDelta(db, t.b.pid, -t.b.gold);
    if (t.b.gold > 0) invRepo.applyGoldDelta(db, t.a.pid, t.b.gold);

    for (const it of t.a.items) {
      invRepo.applyItemDelta(db, t.a.pid, it.kind, it.dataId, -it.count);
      invRepo.applyItemDelta(db, t.b.pid, it.kind, it.dataId, +it.count);
    }
    for (const it of t.b.items) {
      invRepo.applyItemDelta(db, t.b.pid, it.kind, it.dataId, -it.count);
      invRepo.applyItemDelta(db, t.a.pid, it.kind, it.dataId, +it.count);
    }

    db.prepare(
      'INSERT INTO trade_log (ts, a, b, items_json, gold_a, gold_b, ok) VALUES (?, ?, ?, ?, ?, ?, 1)',
    ).run(Date.now(), t.a.pid, t.b.pid, JSON.stringify({ a: t.a.items, b: t.b.items }), t.a.gold, t.b.gold);
  });
  t.state = 'committed';
  end(t, 'committed');
}

function end(t: Trade, reason: string): void {
  pidToTrade.delete(t.a.pid);
  pidToTrade.delete(t.b.pid);
  if (io) {
    const ap = getOnlineByPid(t.a.pid);
    const bp = getOnlineByPid(t.b.pid);
    const payload = { tradeId: t.id, ok: t.state === 'committed', reason };
    if (ap) io.to(ap.socketId).emit('trade.done.evt', payload);
    if (bp) io.to(bp.socketId).emit('trade.done.evt', payload);
  }
  trades.delete(t.id);
  log.info({ tradeId: t.id, reason, a: t.a.pid, b: t.b.pid }, 'trade ended');
}

function broadcastOffer(t: Trade): void {
  if (!io) return;
  const ap = getOnlineByPid(t.a.pid);
  const bp = getOnlineByPid(t.b.pid);
  const payload = {
    tradeId: t.id,
    state: t.state,
    a: { pid: t.a.pid, gold: t.a.gold, items: t.a.items, locked: t.a.locked, confirmed: t.a.confirmed },
    b: { pid: t.b.pid, gold: t.b.gold, items: t.b.items, locked: t.b.locked, confirmed: t.b.confirmed },
  };
  if (ap) io.to(ap.socketId).emit('trade.update.evt', payload);
  if (bp) io.to(bp.socketId).emit('trade.update.evt', payload);
}

function sideOf(t: Trade, pid: number): OfferSide {
  if (t.a.pid === pid) return t.a;
  if (t.b.pid === pid) return t.b;
  throw new AppError('FORBIDDEN', 'not a participant');
}

export function onPlayerDisconnect(pid: number): void {
  const tradeId = pidToTrade.get(pid);
  if (tradeId) {
    try { cancel(tradeId, pid, 'peer_disconnected'); } catch (e) { /* ignore */ }
  }
}
