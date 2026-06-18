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
  // 过期 token 清理间隔 (ms). 0 / 负数 = 关闭定时清理.
  tokenPruneIntervalMs: num(process.env.TOKEN_PRUNE_INTERVAL_MS, 3_600_000),

  // 资产接口单次 delta 封顶 (防客户端一发请求直接刷到 GOLD_CAP).
  // 仅约束 socket 层的 inventory.gainGold / gainItem(玩法掉落/消耗走这里, 单次都很小);
  // GM 发资产走 scripts/gm.ts 直连 DB, 不经过此限制. <=0 表示不限制.
  maxGoldDeltaPerCall: num(process.env.MAX_GOLD_DELTA_PER_CALL, 10_000_000),
  maxItemDeltaPerCall: num(process.env.MAX_ITEM_DELTA_PER_CALL, 1_000),

  logLevel: str(process.env.LOG_LEVEL, 'info'),
} as const;

export type AppConfig = typeof config;
