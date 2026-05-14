import pino from 'pino';
import { config } from './config.js';

const transport = config.isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    }
  : undefined;

export const log = pino({
  level: config.logLevel,
  base: { svc: 'xsg-server' },
  ...(transport ? { transport } : {}),
});

export type Logger = typeof log;

export function childLog(bindings: Record<string, unknown>): Logger {
  return log.child(bindings);
}
