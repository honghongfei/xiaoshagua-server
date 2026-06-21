// 数据管线：从 xiaoshagua/data 抽取家园相关数据。
//  1. MapInfos.json 里「(椰树大厦|空中花园)1层B（家）<tier><style>」的房型装修地图 → home-map-table.json
//     （homeMaps.ts 运行期按 building/tier/style 解析进门底图）。
//  2. Items.json 里家具道具（note 含 <HomeFurniture> 或名称以 “⭐家具-”开头）→ home-furniture-catalog.json
//     并种入 home_furniture_catalog 表（homeRepo.loadCatalog 运行期读表做摆放白名单）。
// 用法：npx tsx scripts/extract-home.ts [可选: 自定义 data 目录]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.argv[2] || join(here, '../../../xiaoshagua/data');
const OUT_MAP = join(here, '../data/home-map-table.json');
const OUT_FURN = join(here, '../data/home-furniture-catalog.json');

// 房型装修地图命名：「<楼栋>1层B（家）<等级><风格>」，例：空中花园1层B（家）7七彩 / 椰树大厦1层B（家）0毛坯。
const HOME_RE = /^(椰树大厦|空中花园)1层B（家）(\d+)(\S+)$/;
const BUILDING: Record<string, string> = { 椰树大厦: 'coconut', 空中花园: 'skygarden' };

const FURN_TAG = /<HomeFurniture>/i;
const FURN_NAME = /^⭐?家具-/; // 兜底：名称以 “⭐家具-” / “家具-” 开头
const LAYER_RE = /<FurnitureLayer:(\d+)>/i;

interface MapInfo {
  id: number;
  name: string;
}
interface ItemDef {
  id: number;
  name?: string;
  note?: string;
}

type HomeMapTable = Record<string, Record<string, number>>; // tier -> style -> mapId（两栋按 tier 合并，等级不重叠）

function extractMaps(): { table: HomeMapTable; count: number } {
  const arr = JSON.parse(readFileSync(join(DATA_DIR, 'MapInfos.json'), 'utf8')) as (MapInfo | null)[];
  const table: HomeMapTable = {};
  let count = 0;
  for (const mi of arr) {
    if (!mi || typeof mi.name !== 'string') continue;
    const m = HOME_RE.exec(mi.name);
    if (!m) continue;
    const building = BUILDING[m[1] ?? ''];
    if (!building) continue; // 仅过滤合法楼栋；扁平表按 tier 索引，building 运行期由 tier 派生
    const tier = String(parseInt(m[2] ?? '0', 10));
    const style = m[3] ?? 'base';
    const byTier = (table[tier] ??= {});
    byTier[style] = mi.id;
    if (tier === '0') byTier['base'] = mi.id; // 默认风格别名，便于新家园（style='base'）直接解析
    count += 1;
  }
  return { table, count };
}

interface CatalogEntry {
  furniture_id: number;
  layer: number;
  w: number;
  h: number;
}

function extractFurniture(): CatalogEntry[] {
  const arr = JSON.parse(readFileSync(join(DATA_DIR, 'Items.json'), 'utf8')) as (ItemDef | null)[];
  const out: CatalogEntry[] = [];
  for (const it of arr) {
    if (!it || typeof it.id !== 'number') continue;
    const note = it.note ?? '';
    const byTag = FURN_TAG.test(note);
    const byName = typeof it.name === 'string' && FURN_NAME.test(it.name);
    if (!byTag && !byName) continue;
    const lm = LAYER_RE.exec(note);
    out.push({ furniture_id: it.id, layer: lm ? parseInt(lm[1] ?? '1', 10) : 1, w: 1, h: 1 });
  }
  return out;
}

function main(): void {
  const { table, count } = extractMaps();
  mkdirSync(dirname(OUT_MAP), { recursive: true });
  writeFileSync(OUT_MAP, JSON.stringify(table, null, 2), 'utf8');

  const furniture = extractFurniture();
  writeFileSync(OUT_FURN, JSON.stringify(furniture, null, 2), 'utf8');

  const tiers = Object.keys(table).length;
  console.log(`home maps: ${count} variants across ${tiers} tiers -> ${OUT_MAP}`);
  console.log(`home furniture: ${furniture.length} items -> ${OUT_FURN}`);
  console.log('提示：把这两个 JSON 用 git add -f 强制提交，随部署上服务器（loadCatalog/homeMaps 运行期读它们）。');
}

main();
