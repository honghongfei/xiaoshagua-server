import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 房型 → 真实装修地图：按 tier 扁平索引（两栋楼等级不重叠，故 tier 唯一定位一张图集）。
// 结构: { [tier]: { [style]: realMapId } }，由 scripts/extract-home.ts 从 MapInfos.json 抽取。
type HomeMapTable = Record<string, Record<string, number>>;

const here = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(here, '../../../data/home-map-table.json');

let table: HomeMapTable = {};

// 每楼栋的进门落点（与对应装修图入口对齐；落点细节可在联机自测时按图微调）。
const SPAWN: Record<string, { x: number; y: number; d: number }> = {
  coconut: { x: 8, y: 9, d: 2 },
  skygarden: { x: 8, y: 9, d: 2 },
};

// 0 级毛坯兜底（空中花园 1层B（家）0毛坯 = Map152，与抽取表一致）。
const FALLBACK_MAP_ID = 152;

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

// 模块加载即读一次（缺文件时空表，resolveBaseMap 走兜底）。
loadHomeMapTable();

// 楼栋按等级派生：低阶椰树大厦(0~6)，满后空中花园(7~17)。单一真值 = tier。
export function buildingForTier(tier: number): 'coconut' | 'skygarden' {
  return tier <= 6 ? 'coconut' : 'skygarden';
}

export function resolveBaseMap(tier: number, style: string): number {
  const byStyle = table[String(tier)] ?? table['0'] ?? {};
  if (byStyle[style] != null) return byStyle[style];
  const first = Object.values(byStyle)[0];
  return first != null ? first : FALLBACK_MAP_ID;
}

export function spawnFor(building: string): { x: number; y: number; d: number } {
  return SPAWN[building] ?? SPAWN.coconut;
}

export function stylesForTier(tier: number): string[] {
  const byTier = table[String(tier)];
  const keys = byTier ? Object.keys(byTier) : [];
  return keys.length > 0 ? keys : ['base'];
}
