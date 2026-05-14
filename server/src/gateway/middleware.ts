import type { Socket } from 'socket.io';
import { config } from '../config.js';
import { createBucket } from '../util/throttle.js';
import type { GameSocket, SocketSession } from './types.js';

export function attachSession(socket: Socket): GameSocket {
  const session: SocketSession = {
    authed: false,
    pid: null,
    accountId: null,
    token: null,
    bucket: createBucket(config.maxMessagesPerSec, config.maxMessagesPerSec * 2),
  };
  (socket as GameSocket).session = session;
  return socket as GameSocket;
}

export function takeToken(socket: GameSocket): boolean {
  return socket.session.bucket.take(1);
}
