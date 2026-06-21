import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 房型 → 真实装修地图映射表，由 scripts/extract-home.ts 从 MapInfos.json 抽取。
// 结构: { [building]: { [tier]: { [style]: realMapId } } }
type HomeMapTable = Record<string, Record<string, Record<string, number>>>;

const here = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(here, '../../../data/home-map-table.json');

let table: HomeMapTable = {};

// 每楼栋的进门落点（与对应装修图的入口对齐；缺省落 coconut 默认点）。
const SPAWN: Record<string, { x: number; y: number; d: number }> = {
  coconut: { x: 8, y: 9, d: 2 },
  skygarden: { x: 8, y: 9, d: 2 },
};

// 0 级毛坯兜底地图（空中花园 1 层B（家）0级毛坯房 = Map061）。
const FALLBACK_MAP_ID = 61;

export function loadHomeMapTable(): HomeMapTable {
  if (existsSync(TABLE_PATH)) {
    try {
      table = JSON.parse(readFileSync(TABLE_PATH, 'utf8')) as HomeMapTable;
    } catch {
      table = {};
    }
  }
  return table;
}

// 模块加载即尝试读取一次（缺文件时为空表，resolveBaseMap 走兜底）。
loadHomeMapTable();

export function resolveBaseMap(building: string, tier: number, style: string): number {
  const byBuilding = table[building] ?? {};
  const byStyle = byBuilding[String(tier)] ?? byBuilding['0'] ?? {};
  if (byStyle[style] != null) return byStyle[style];
  const first = Object.values(byStyle)[0];
  return first != null ? first : FALLBACK_MAP_ID;
}

export function spawnFor(building: string): { x: number; y: number; d: number } {
  return SPAWN[building] ?? SPAWN.coconut;
}

export function stylesForTier(building: string, tier: number): string[] {
  const byTier = (table[building] ?? {})[String(tier)];
  const keys = byTier ? Object.keys(byTier) : [];
  return keys.length > 0 ? keys : ['base'];
}
