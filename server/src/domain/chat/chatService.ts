import type { Server } from 'socket.io';
import { AppError } from '../../util/errors.js';
import { createBucket, type TokenBucket } from '../../util/throttle.js';
import { getOnlineByPid } from '../player/playerService.js';
import { room } from '../world/worldService.js';
import { isBlocked } from '../social/socialService.js';
import * as repo from './chatRepo.js';

export type ChatChannel = 'world' | 'nearby' | 'whisper';

const MAX_LEN = 200;

// 3 messages per 10 seconds per pid
const chatBuckets = new Map<number, TokenBucket>();

function bucketOf(pid: number): TokenBucket {
  let b = chatBuckets.get(pid);
  if (!b) {
    b = createBucket(0.3, 3);
    chatBuckets.set(pid, b);
  }
  return b;
}

let io: Server | null = null;
export function attachChatIo(server: Server): void {
  io = server;
}

export interface SendInput {
  fromPid: number;
  channel: ChatChannel;
  text: string;
  targetPid?: number | null;
}

export interface ChatEvt {
  channel: ChatChannel;
  fromPid: number;
  fromName: string;
  toPid?: number | null;
  text: string;
  ts: number;
}

export function send(input: SendInput): ChatEvt {
  const text = (input.text || '').trim();
  if (!text) throw new AppError('CHAT_EMPTY', 'message empty');
  if (text.length > MAX_LEN) throw new AppError('CHAT_TOO_LONG', `>${MAX_LEN} chars`);
  if (!bucketOf(input.fromPid).take(1)) {
    throw new AppError('CHAT_RATE_LIMIT', 'too fast, slow down');
  }

  const from = getOnlineByPid(input.fromPid);
  if (!from) throw new AppError('NO_AUTH', 'sender offline');

  const ts = Date.now();
  const evt: ChatEvt = {
    channel: input.channel,
    fromPid: from.pid,
    fromName: from.name,
    text,
    ts,
  };

  if (!io) throw new AppError('INTERNAL', 'io not attached', 500);

  switch (input.channel) {
    case 'world': {
      // M7 修：用 socket.io room 'world' 一次广播, 替代 O(n) 逐 emit。
      // 被拉黑的用户在客户端有 isBlocked 兜底, 这里偷懒不做服端过滤换 O(1) emit。
      // (准确想做的话, 用 socket.io 的 except/rooms 但代价不值得)
      repo.insertChat(ts, 'world', from.pid, null, text);
      io.to('world').emit('chat.evt', evt);
      break;
    }
    case 'nearby': {
      repo.insertChat(ts, 'nearby', from.pid, null, text);
      const r = room(from.mapId);
      const sockets = io.sockets.adapter.rooms.get(r);
      if (sockets) {
        for (const sid of sockets) {
          const sock = io.sockets.sockets.get(sid);
          if (!sock) continue;
          const pid = ((sock as unknown) as { session?: { pid: number | null } }).session?.pid;
          if (pid && isBlocked(pid, from.pid)) continue;
          sock.emit('chat.evt', evt);
        }
      }
      break;
    }
    case 'whisper': {
      const targetPid = input.targetPid;
      if (!targetPid) throw new AppError('BAD_INPUT', 'whisper needs targetPid');
      const target = getOnlineByPid(targetPid);
      if (!target) throw new AppError('TARGET_OFFLINE', 'target offline');
      if (isBlocked(targetPid, from.pid)) {
        // silently drop on target side; return shadow ack to sender
        evt.toPid = targetPid;
        repo.insertChat(ts, 'whisper', from.pid, targetPid, text);
        const senderSocket = io.sockets.sockets.get(from.socketId);
        if (senderSocket) senderSocket.emit('chat.evt', evt);
        break;
      }
      evt.toPid = targetPid;
      repo.insertChat(ts, 'whisper', from.pid, targetPid, text);
      io.to(target.socketId).emit('chat.evt', evt);
      const senderSocket = io.sockets.sockets.get(from.socketId);
      if (senderSocket && senderSocket.id !== target.socketId) {
        senderSocket.emit('chat.evt', evt);
      }
      break;
    }
    default:
      throw new AppError('BAD_INPUT', 'unknown channel');
  }

  return evt;
}

export function broadcastSystem(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  if (!io) return;
  io.emit('sys.notice', { level, text, ts: Date.now() });
}

export function clearBucket(pid: number): void {
  chatBuckets.delete(pid);
}
