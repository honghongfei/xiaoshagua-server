// 资源槽位表：由 scripts/extract-resources.ts 从 data/Map*.json 生成。
// 运行期内存态，启动按本表重生；缺 respawnMs 用 config 默认(每点被采后 30 分钟)。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../../config.js';

export interface SpawnSlot {
  x: number;
  y: number;
  itemId: number;
  respawnMs: number;
}

export type SpawnTable = Record<number, SpawnSlot[]>; // mapId -> slots

const here = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(here, '../../../data/gather-spawn-table.json');

let table: SpawnTable = {};

export function loadSpawnTable(): SpawnTable {
  if (existsSync(TABLE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(TABLE_PATH, 'utf8')) as SpawnTable;
      for (const slots of Object.values(raw)) {
        for (const s of slots) {
          if (!s.respawnMs || s.respawnMs <= 0) s.respawnMs = config.gatherDefaultRespawnMs;
        }
      }
      table = raw;
    } catch {
      table = {};
    }
  }
  return table;
}

// 测试 / GM 用：直接注入槽位表
export function setSpawnTable(t: SpawnTable): void {
  table = t;
}

export function getSpawnTable(): SpawnTable {
  return table;
}

export function slotsForMap(mapId: number): SpawnSlot[] {
  return table[mapId] ?? [];
}
