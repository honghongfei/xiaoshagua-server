import type { Socket } from 'socket.io';
import type { TokenBucket } from '../util/throttle.js';

export interface SocketSession {
  authed: boolean;
  pid: number | null;
  accountId: number | null;
  token: string | null;
  bucket: TokenBucket;
}

export type GameSocket = Socket & { session: SocketSession };

export interface AckResponse<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export function okAck<T>(data: T): AckResponse<T> {
  return { ok: true, data };
}

export function failAck(code: string, message: string): AckResponse<never> {
  return { ok: false, error: { code, message } };
}
