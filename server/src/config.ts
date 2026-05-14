import 'dotenv/config';
import path from 'node:path';

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function str(v: string | undefined, dflt: string): string {
  return v && v.length > 0 ? v : dflt;
}

const NODE_ENV = str(process.env.NODE_ENV, 'development');

export const config = {
  env: NODE_ENV,
  isDev: NODE_ENV !== 'production',
  host: str(process.env.HOST, '0.0.0.0'),
  port: num(process.env.PORT, 3000),

  dbPath: path.resolve(str(process.env.DB_PATH, './data/xsg.db')),

  maxMessagesPerSec: num(process.env.MAX_MESSAGES_PER_SEC, 20),
  maxPlayersPerMap: num(process.env.MAX_PLAYERS_PER_MAP, 50),
  worldTickMs: num(process.env.WORLD_TICK_MS, 200),

  tokenTtlSec: num(process.env.TOKEN_TTL_SEC, 86400),

  logLevel: str(process.env.LOG_LEVEL, 'info'),
} as const;

export type AppConfig = typeof config;
