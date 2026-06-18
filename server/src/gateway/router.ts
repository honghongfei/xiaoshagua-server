import type { Server } from 'socket.io';
import type { ZodSchema } from 'zod';
import { log } from '../log.js';
import { AppError, isAppError } from '../util/errors.js';
import {
  AuthLogin,
  AuthRegister,
  AuthResume,
  CharRename,
  ChatSend,
  InventoryGainGold,
  InventoryGainItem,
  InventoryReplace,
  InventoryUse,
  PidOnly,
  PidWithKind,
  PlayerAction,
  PlayerEnterMap,
  PlayerMove,
  SaveUpload,
  SocialSearch,
  StateSetSwitch,
  StateSetVar,
} from '../util/schema.js';
import {
  getCharacter,
  getOnlineByPid,
  getOnlineBySocket,
  listOnline,
  login,
  markOffline,
  markOnline,
  persistPosition,
  register,
  renameCharacter,
  resume,
  updateCharacterAppearance,
  type CharacterPublic,
} from '../domain/player/playerService.js';
import {
  actOnMap,
  attachIo,
  enterMap,
  leaveMap,
  moveOnMap,
  startTick,
  stats,
} from '../domain/world/worldService.js';
import {
  attachChatIo,
  broadcastSystem,
  clearBucket as clearChatBucket,
  send as sendChat,
} from '../domain/chat/chatService.js';
import {
  addFriend,
  blockOther,
  invalidateCacheFor,
  listBlocks,
  listFriends,
  removeFriend,
  searchByName,
  unblockOther,
} from '../domain/social/socialService.js';
import {
  gainGold as invGainGold,
  gainItem as invGainItem,
  replaceInventory as invReplaceInventory,
  snapshot as invSnapshot,
  useItem as invUseItem,
} from '../domain/inventory/inventoryService.js';
import {
  assertSwitchAllowed,
  assertVariableAllowed,
  attachStateIo,
  setSharedSwitch,
  setSharedVariable,
  snapshotShared,
} from '../domain/state/stateService.js';
import {
  downloadSave,
  hasSave,
  uploadSave,
} from '../domain/storage/storageService.js';
import {
  attachTradeIo,
  cancel as tradeCancel,
  confirm as tradeConfirm,
  invite as tradeInvite,
  lock as tradeLock,
  onPlayerDisconnect as tradeOnDisconnect,
  respond as tradeRespond,
  setOffer as tradeSetOffer,
  unlock as tradeUnlock,
} from '../domain/trade/tradeService.js';
import {
  adopt as petAdopt,
  evolve as petEvolve,
  feed as petFeed,
  list as petList,
  train as petTrain,
} from '../domain/pet/petService.js';
import {
  attachDungeonIo,
  enter as dungeonEnter,
  leave as dungeonLeave,
  onPlayerDisconnect as dungeonOnDisconnect,
} from '../domain/dungeon/dungeonService.js';
import {
  ackNotifications as marketAckNotifications,
  browse as marketBrowse,
  buyListing as marketBuy,
  cancelListing as marketCancel,
  createListing as marketCreate,
  getMine as marketGetMine,
  listNotifications as marketListNotifications,
  unlockSlot as marketUnlockSlot,
} from '../domain/market/marketService.js';
import {
  DungeonEnter,
  MarketAck,
  MarketBrowse,
  MarketBuy,
  MarketCreate,
  MarketIdOnly,
  PetAct,
  PetCreate,
  TradeIdOnly,
  TradeInvite,
  TradeOffer,
  TradeRespond,
} from '../util/schema.js';
import { attachSession, takeToken } from './middleware.js';
import { failAck, okAck, type AckResponse, type GameSocket } from './types.js';

type AckFn = (resp: AckResponse<unknown>) => void;

function safeAck(ack: unknown): AckFn | null {
  return typeof ack === 'function' ? (ack as AckFn) : null;
}

function parse<T>(schema: ZodSchema<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError('BAD_INPUT', r.error.issues.map((i) => i.message).join('; '));
  }
  return r.data;
}

function pickCharacterForClient(c: CharacterPublic): CharacterPublic {
  return c;
}

// M14 修：上线/下线公告防抖。
// - 玩家断线后 OFFLINE_GRACE_MS 内不发"下线了", 给重连留窗口。
// - 玩家重新进入地图时, 如果在 grace 中, 取消 pending 下线通知 + 跳过"上线了"。
// - 仅在玩家"真的从无到有"上线时, 广播一次。
const OFFLINE_GRACE_MS = 5_000;
const pendingOfflineByPid = new Map<number, NodeJS.Timeout>();

function scheduleOfflineBroadcast(pid: number, name: string): void {
  const old = pendingOfflineByPid.get(pid);
  if (old) clearTimeout(old);
  const t = setTimeout(() => {
    pendingOfflineByPid.delete(pid);
    // 5s 后再确认一次：如果 pid 已经重新在线了, 跳过
    if (getOnlineByPid(pid)) return;
    broadcastSystem(`${name} 下线了`);
  }, OFFLINE_GRACE_MS);
  pendingOfflineByPid.set(pid, t);
}

function clearPendingOffline(pid: number): boolean {
  const t = pendingOfflineByPid.get(pid);
  if (!t) return false;
  clearTimeout(t);
  pendingOfflineByPid.delete(pid);
  return true;
}

export function installRouter(io: Server): void {
  attachIo(io);
  attachChatIo(io);
  attachStateIo(io);
  attachTradeIo(io);
  attachDungeonIo(io);
  startTick();

  io.on('connection', (raw) => {
    const socket = attachSession(raw);
    log.debug({ sid: socket.id }, 'socket connected');

    socket.on('disconnect', (reason) => {
      const p = markOffline(socket.id);
      if (p) {
        try {
          persistPosition(p);
        } catch (err) {
          log.warn({ err, pid: p.pid }, 'flush on disconnect failed');
        }
        leaveMap(p.pid, p.mapId);
        clearChatBucket(p.pid);
        tradeOnDisconnect(p.pid);
        dungeonOnDisconnect(p.pid);
        // M14 修：socket 重连/切图导致的短暂断开会触发 disconnect→connect 风暴，
        // 之前每次都广播"X 下线了"+"X 上线了"两条系统公告，玩家右下角刷屏。
        // 现在延迟 5s 再广播，期间若 pid 重新出现在 onlineByPid 即视为同会话重连，丢弃通知。
        scheduleOfflineBroadcast(p.pid, p.name);
      }
      log.debug({ sid: socket.id, reason }, 'socket disconnected');
    });

    socket.on('auth.register', async (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const input = parse(AuthRegister, raw);
        const session = await register(input);
        const character = pickCharacterForClient(getCharacter(session.characterId));
        bindSession(socket, session.accountId, session.characterId, session.token);
        cb?.(okAck({ token: session.token, character }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('auth.login', async (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const input = parse(AuthLogin, raw);
        const session = await login(input);
        const character = pickCharacterForClient(getCharacter(session.characterId));
        bindSession(socket, session.accountId, session.characterId, session.token);
        cb?.(okAck({ token: session.token, character }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('auth.resume', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const input = parse(AuthResume, raw);
        const { session, character } = resume(input.token);
        bindSession(socket, session.accountId, session.characterId, session.token);
        cb?.(okAck({ token: session.token, character }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('character.rename', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(CharRename, raw);
        cb?.(okAck(renameCharacter(s.pid, input.name)));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('player.enterMap', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const session = socket.session;
        if (!session.authed || session.pid === null) throw new AppError('NO_AUTH', 'login required');
        const input = parse(PlayerEnterMap, raw);
        const character = getCharacter(session.pid);
        // 三步闭环 - 角色贴图同步:
        //   1. 客户端在 enterMap 里把当前角色 characterName / characterIndex 上来
        //   2. 服端用 client 给的覆盖 DB 老值, 并 persist 到 character.char_set / char_index
        //   3. 其他客户端的 world.delta / others snapshot 就能拿到正确贴图
        const effectiveCharSet = input.charSet ?? character.charSet;
        const effectiveCharIndex = input.charIndex ?? character.charIndex;
        // charSet 或 charIndex 任一变化都要写库 (M11 修)
        const charSetChanged = input.charSet != null && input.charSet !== character.charSet;
        const charIndexChanged = input.charIndex != null && input.charIndex !== character.charIndex;
        if ((charSetChanged || charIndexChanged) && effectiveCharSet != null) {
          updateCharacterAppearance(session.pid, effectiveCharSet, effectiveCharIndex ?? 0);
        }
        // M14 修：先抓取旧 player（若存在），用它的旧 mapId 离开旧地图。
        // 旧实现先 markOnline 再 enterMap，会把 player.mapId 提前覆盖为新 mapId,
        // 导致 enterMap 内的 `player.mapId !== mapId` 检查永远为假，旧地图的其他玩家
        // 永远收不到 leave 事件，他们看到的 sprite 会卡在原地。
        const previous = getOnlineBySocket(socket.id);
        const previousMapId = previous?.mapId ?? 0;
        const wasOnline = previous != null;
        if (previous && previousMapId && previousMapId !== input.mapId) {
          leaveMap(previous.pid, previousMapId);
        }
        // 若该 pid 在 grace 期内重连, 取消 pending "下线了" 通知, 同时视为重连而非真上线。
        const wasReconnect = clearPendingOffline(session.pid);
        markOnline({
          pid: session.pid,
          accountId: session.accountId ?? 0,
          socketId: socket.id,
          name: character.name,
          actorId: character.actorId,
          mapId: input.mapId,
          x: input.x,
          y: input.y,
          d: input.d,
          charSet: effectiveCharSet,
          charIndex: effectiveCharIndex,
          level: character.level,
          lastActAt: Date.now(),
        });
        const player = getOnlineBySocket(socket.id);
        if (!player) throw new AppError('INTERNAL', 'online state lost', 500);
        const { snapshot } = enterMap(player, input.mapId, input.x, input.y, input.d);
        // M14 修：仅在玩家「真正首次上线」时广播，避免每次切图都刷一次「上线了」公告。
        if (!wasOnline && !wasReconnect) {
          broadcastSystem(`${player.name} 上线了`);
        }
        cb?.(okAck(snapshot));
        // 进图后补发离线期间攒下的寄售通知（卖出回执等）。
        flushMarketNotifications(io, session.pid);
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('player.move', (raw) => {
      try {
        if (!takeToken(socket)) return;
        const session = socket.session;
        if (!session.authed || session.pid === null) return;
        const input = parse(PlayerMove, raw);
        moveOnMap(session.pid, input.x, input.y, input.d);
      } catch (err) {
        if (isAppError(err)) {
          log.debug({ code: err.code, msg: err.message }, 'player.move rejected');
        } else {
          log.warn({ err }, 'player.move error');
        }
      }
    });

    socket.on('player.action', (raw) => {
      try {
        if (!takeToken(socket)) return;
        const session = socket.session;
        if (!session.authed || session.pid === null) return;
        const input = parse(PlayerAction, raw);
        actOnMap(session.pid, input.type);
      } catch (err) {
        if (!isAppError(err)) log.warn({ err }, 'player.action error');
      }
    });

    socket.on('admin.stats', (_raw, ack) => {
      const cb = safeAck(ack);
      cb?.(okAck({ online: listOnline().length, ...stats() }));
    });

    // 在线玩家列表(联机中心 Hub 的"在线玩家"格用): 直接私聊/加好友/邀交易, 不必跑到对方身边
    socket.on('player.listOnline', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        requireAuth(socket);
        const players = listOnline().map((p) => ({ pid: p.pid, name: p.name, mapId: p.mapId, level: p.level }));
        cb?.(okAck({ players }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('chat.send', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const session = socket.session;
        if (!session.authed || session.pid === null) throw new AppError('NO_AUTH', 'login required');
        const input = parse(ChatSend, raw);
        const evt = sendChat({
          fromPid: session.pid,
          channel: input.channel,
          text: input.text,
          targetPid: input.targetPid,
        });
        cb?.(okAck({ ts: evt.ts }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('social.list', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests'); // M8 修
        const session = socket.session;
        if (!session.authed || session.pid === null) throw new AppError('NO_AUTH', 'login required');
        cb?.(okAck({ friends: listFriends(session.pid), blocks: listBlocks(session.pid) }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('social.add', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const session = socket.session;
        if (!session.authed || session.pid === null) throw new AppError('NO_AUTH', 'login required');
        const input = parse(PidWithKind, raw);
        if (input.kind === 'friend') addFriend(session.pid, input.pid);
        else blockOther(session.pid, input.pid);
        cb?.(okAck({ ok: true }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('social.remove', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const session = socket.session;
        if (!session.authed || session.pid === null) throw new AppError('NO_AUTH', 'login required');
        const input = parse(PidWithKind, raw);
        if (input.kind === 'friend') removeFriend(session.pid, input.pid);
        else unblockOther(session.pid, input.pid);
        invalidateCacheFor(session.pid);
        cb?.(okAck({ ok: true }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('social.search', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(SocialSearch, raw);
        cb?.(okAck({ results: searchByName(s.pid, input.name) }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    socket.on('social.lookup', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        const session = socket.session;
        if (!session.authed || session.pid === null) throw new AppError('NO_AUTH', 'login required');
        const input = parse(PidOnly, raw);
        const list = listOnline().filter((p) => p.pid === input.pid).map((p) => ({
          pid: p.pid,
          name: p.name,
          mapId: p.mapId,
        }));
        cb?.(okAck({ found: list.length > 0, entry: list[0] || null }));
      } catch (err) {
        sendError(socket, cb, err);
      }
    });

    // --------- M3: inventory ---------
    socket.on('inventory.snapshot', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        const s = requireAuth(socket);
        cb?.(okAck(invSnapshot(s.pid)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('inventory.gainGold', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(InventoryGainGold, raw);
        const result = invGainGold(s.pid, input.amount, input.reason);
        socket.emit('inventory.delta', { gold: result.appliedDelta, newGold: result.newTotal });
        cb?.(okAck(result));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('inventory.gainItem', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(InventoryGainItem, raw);
        const result = invGainItem(s.pid, input.kind, input.dataId, input.amount, input.reason);
        socket.emit('inventory.delta', {
          items: [{ kind: input.kind, dataId: input.dataId, deltaCount: result.appliedDelta, newCount: result.newTotal }],
        });
        cb?.(okAck(result));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('inventory.use', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(InventoryUse, raw);
        const result = invUseItem(s.pid, input.kind, input.dataId, input.count);
        socket.emit('inventory.delta', {
          items: [{ kind: input.kind, dataId: input.dataId, deltaCount: result.appliedDelta, newCount: result.newTotal }],
        });
        cb?.(okAck(result));
      } catch (err) { sendError(socket, cb, err); }
    });

    // inventory.replace: 全量覆盖. 配合 SaveMigrate 上传时把本地存档里的
    // _gold / _items / _weapons / _armors 灌进权威表, 防止下次 reconcile
    // 把本地资产清零. 不广播 inventory.delta (调用者通常会立刻退出菜单回标题).
    socket.on('inventory.replace', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(InventoryReplace, raw);
        const result = invReplaceInventory(s.pid, { gold: input.gold, items: input.items }, input.reason);
        // 给当前 socket 推一次新 snapshot 方便客户端立刻刷新, 但不向其他人广播.
        socket.emit('inventory.delta', { gold: 0, replaced: true, newGold: result.gold });
        cb?.(okAck(result));
      } catch (err) { sendError(socket, cb, err); }
    });

    // --------- M3: shared state ---------
    socket.on('state.snapshot', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        requireAuth(socket);
        cb?.(okAck(snapshotShared()));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('state.setSwitch', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        requireAuth(socket);
        const input = parse(StateSetSwitch, raw);
        assertSwitchAllowed(input.id);
        const changed = setSharedSwitch(input.id, input.value);
        cb?.(okAck({ changed }));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('state.setVar', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        requireAuth(socket);
        const input = parse(StateSetVar, raw);
        assertVariableAllowed(input.id);
        const changed = setSharedVariable(input.id, input.value);
        cb?.(okAck({ changed }));
      } catch (err) { sendError(socket, cb, err); }
    });

    // --------- M3: cloud save ---------
    socket.on('save.upload', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(SaveUpload, raw);
        const blob = uploadSave(s.pid, input.contents, input.meta, input.baseTs);
        cb?.(okAck({ ts: blob.ts }));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('save.download', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        const s = requireAuth(socket);
        const blob = downloadSave(s.pid);
        cb?.(okAck({ found: !!blob, blob }));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('save.exists', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests'); // M8 修
        const s = requireAuth(socket);
        cb?.(okAck({ exists: hasSave(s.pid) }));
      } catch (err) { sendError(socket, cb, err); }
    });

    // --------- M4: trade ---------
    socket.on('trade.invite', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(TradeInvite, raw);
        cb?.(okAck(tradeInvite(s.pid, input.targetPid)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('trade.respond', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(TradeRespond, raw);
        tradeRespond(input.tradeId, s.pid, input.accept);
        cb?.(okAck({ ok: true }));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('trade.offer', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(TradeOffer, raw);
        tradeSetOffer(input.tradeId, s.pid, input.gold, input.items);
        cb?.(okAck({ ok: true }));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('trade.lock', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(TradeIdOnly, raw);
        tradeLock(input.tradeId, s.pid);
        cb?.(okAck({ ok: true }));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('trade.unlock', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(TradeIdOnly, raw);
        tradeUnlock(input.tradeId, s.pid);
        cb?.(okAck({ ok: true }));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('trade.confirm', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(TradeIdOnly, raw);
        tradeConfirm(input.tradeId, s.pid);
        cb?.(okAck({ ok: true }));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('trade.cancel', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(TradeIdOnly, raw);
        tradeCancel(input.tradeId, s.pid);
        cb?.(okAck({ ok: true }));
      } catch (err) { sendError(socket, cb, err); }
    });

    // --------- M4: pets ---------
    socket.on('pet.list', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests'); // M8 修
        const s = requireAuth(socket);
        cb?.(okAck({ pets: petList(s.pid) }));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('pet.adopt', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(PetCreate, raw);
        cb?.(okAck(petAdopt(s.pid, input.speciesId, input.name)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('pet.act', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(PetAct, raw);
        let r;
        if (input.action === 'feed') r = petFeed(input.petId, s.pid);
        else if (input.action === 'train') r = petTrain(input.petId, s.pid);
        else if (input.action === 'evolve') r = petEvolve(input.petId, s.pid);
        else throw new AppError('NOT_IMPL', 'action not implemented: ' + input.action);
        cb?.(okAck(r));
      } catch (err) { sendError(socket, cb, err); }
    });

    // --------- M5: dungeon ---------
    socket.on('dungeon.enter', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(DungeonEnter, raw);
        cb?.(okAck(dungeonEnter(s.pid, input.dungeonId, input.partyIds || [])));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('dungeon.leave', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        const s = requireAuth(socket);
        dungeonLeave(s.pid);
        cb?.(okAck({ ok: true }));
      } catch (err) { sendError(socket, cb, err); }
    });

    // --------- 寄售行（Consignment House） ---------
    socket.on('market.browse', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(MarketBrowse, raw);
        cb?.(okAck(marketBrowse({ viewerPid: s.pid, kind: input.kind, q: input.q, offset: input.offset, limit: input.limit })));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('market.mine', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        cb?.(okAck(marketGetMine(s.pid)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('market.create', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(MarketCreate, raw);
        cb?.(okAck(marketCreate(s.pid, input.kind, input.dataId, input.count, input.unitPrice)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('market.cancel', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(MarketIdOnly, raw);
        cb?.(okAck(marketCancel(s.pid, input.listingId)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('market.buy', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(MarketBuy, raw);
        const res = marketBuy(s.pid, input.listingId, input.qty);
        cb?.(okAck(res));
        // 成交后投递通知：卖家（在线即时 / 离线留邮箱）+ 买家自己的成交回执。
        flushMarketNotifications(io, res.sellerId);
        flushMarketNotifications(io, s.pid);
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('market.unlockSlot', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        cb?.(okAck(marketUnlockSlot(s.pid)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('market.notifications', (_raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        cb?.(okAck(marketListNotifications(s.pid)));
      } catch (err) { sendError(socket, cb, err); }
    });

    socket.on('market.ack', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const s = requireAuth(socket);
        const input = parse(MarketAck, raw);
        cb?.(okAck(marketAckNotifications(s.pid, input.ids)));
      } catch (err) { sendError(socket, cb, err); }
    });
  });
}

// 推送某玩家的未读寄售通知（仅在线时）。用于成交后即时推 + 进图补发离线队列。
// 离线则不动，留在 notification 表，待其下次 enterMap 再补发。
function flushMarketNotifications(io: Server, pid: number): void {
  const online = getOnlineByPid(pid);
  if (!online) return;
  const { items } = marketListNotifications(pid);
  if (items.length === 0) return;
  io.to(online.socketId).emit('market.notify.evt', { items });
  marketAckNotifications(pid, items.map((i) => i.id));
}

function requireAuth(socket: GameSocket): { pid: number; accountId: number } {
  const s = socket.session;
  if (!s.authed || s.pid === null) throw new AppError('NO_AUTH', 'login required');
  return { pid: s.pid, accountId: s.accountId ?? 0 };
}

function bindSession(
  socket: GameSocket,
  accountId: number,
  pid: number,
  token: string,
): void {
  socket.session.authed = true;
  socket.session.accountId = accountId;
  socket.session.pid = pid;
  socket.session.token = token;
}

function sendError(socket: GameSocket, cb: AckFn | null, err: unknown): void {
  if (isAppError(err)) {
    if (cb) cb(failAck(err.code, err.message));
    else socket.emit('sys.error', { code: err.code, msg: err.message });
  } else {
    log.error({ err, sid: socket.id }, 'unhandled handler error');
    if (cb) cb(failAck('INTERNAL', 'internal error'));
    else socket.emit('sys.error', { code: 'INTERNAL', msg: 'internal error' });
  }
}
