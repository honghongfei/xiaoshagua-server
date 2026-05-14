import type { Server } from 'socket.io';
import type { ZodSchema } from 'zod';
import { log } from '../log.js';
import { AppError, isAppError } from '../util/errors.js';
import {
  AuthLogin,
  AuthRegister,
  AuthResume,
  ChatSend,
  InventoryGainGold,
  InventoryGainItem,
  InventoryUse,
  PidOnly,
  PidWithKind,
  PlayerAction,
  PlayerEnterMap,
  PlayerMove,
  SaveUpload,
  StateSetSwitch,
  StateSetVar,
} from '../util/schema.js';
import {
  getCharacter,
  getOnlineBySocket,
  listOnline,
  login,
  markOffline,
  markOnline,
  persistPosition,
  register,
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
  unblockOther,
} from '../domain/social/socialService.js';
import {
  gainGold as invGainGold,
  gainItem as invGainItem,
  snapshot as invSnapshot,
  useItem as invUseItem,
} from '../domain/inventory/inventoryService.js';
import {
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
  DungeonEnter,
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
        broadcastSystem(`${p.name} 下线了`);
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
        if (input.charSet != null && input.charSet !== character.charSet) {
          updateCharacterAppearance(session.pid, input.charSet, input.charIndex ?? character.charIndex);
        }
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
        broadcastSystem(`${player.name} 上线了`);
        cb?.(okAck(snapshot));
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
        const blob = uploadSave(s.pid, input.contents, input.meta);
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
  });
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
