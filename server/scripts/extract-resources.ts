// 数据管线：扫 xiaoshagua/data/Map*.json，提取带 <Resource> note 的事件坐标 + 其首个「改变物品(126)」的 itemId，
// 生成 server/data/gather-spawn-table.json（gatherService 启动按此重生）。改图后重跑。
// 用法：npx tsx scripts/extract-resources.ts [可选: 自定义 data 目录]
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.argv[2] || join(here, '../../../xiaoshagua/data');
const OUT = join(here, '../data/gather-spawn-table.json');
const TAG = /<Resource>/i;
const DEFAULT_RESPAWN_MS = 1_800_000; // 每点被采后 30 分钟重生

interface Slot {
  x: number;
  y: number;
  itemId: number;
  respawnMs: number;
}

interface RmCommand {
  code: number;
  parameters: unknown[];
}
interface RmPage {
  list?: RmCommand[];
}
interface RmEvent {
  x: number;
  y: number;
  note?: string;
  pages?: RmPage[];
}
interface RmMap {
  events?: (RmEvent | null)[];
}

function firstGainItemId(ev: RmEvent): number | null {
  for (const page of ev.pages ?? []) {
    for (const cmd of page.list ?? []) {
      // 126 = 改变物品；parameters[0] = itemId
      if (cmd && cmd.code === 126 && typeof cmd.parameters?.[0] === 'number') {
        return cmd.parameters[0] as number;
      }
    }
  }
  return null;
}

function main(): void {
  const table: Record<number, Slot[]> = {};
  let total = 0;
  const files = readdirSync(DATA_DIR).filter((f) => /^Map\d+\.json$/.test(f));
  for (const f of files) {
    const mapId = Number(/^Map(\d+)\.json$/.exec(f)![1]);
    let map: RmMap;
    try {
      map = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')) as RmMap;
    } catch {
      continue;
    }
    const slots: Slot[] = [];
    for (const ev of map.events ?? []) {
      if (!ev || !ev.note || !TAG.test(ev.note)) continue;
      const itemId = firstGainItemId(ev);
      if (itemId == null) continue;
      slots.push({ x: ev.x, y: ev.y, itemId, respawnMs: DEFAULT_RESPAWN_MS });
    }
    if (slots.length) {
      table[mapId] = slots;
      total += slots.length;
    }
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(table, null, 2), 'utf8');
  console.log(
    `extracted ${total} resource slots across ${Object.keys(table).length} maps -> ${OUT}`,
  );
}

main();
