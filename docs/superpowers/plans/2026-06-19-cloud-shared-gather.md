# 地上物云端共享 / 宝宝联机采集 实现计划

> **面向 AI 代理的工作者：** 用 executing-plans 逐任务实现。完整设计见 `../specs/2026-06-19-cloud-shared-gather-design.md`，本计划只列可执行步骤与验证。依赖 ①② 已落地（`2026-06-19-native-pet-afk-visibility.md`）。
> **资源模型假设：** 全服竞争（先到先得、被认领即全员 despawn）。若改「各采各份」，仅 ③b 的 despawn 改为只对认领者本人、去掉跨玩家仲裁，其余不变。
>
> **已锁定决策（2026-06-19，用户确认）+ ③a/③b 实现修订（已落地）：**
> 1. **刷新模型**：乙·每节点 respawn，**计时从「被采」起算**，默认 **1,800,000ms（30 分钟）**（原计划误写 60s，已废）。`config.gatherDefaultRespawnMs` 兜底，可按槽位覆盖；`nextSpawnAt` 在 `tryClaim` 成功时设为 `now + node.respawnMs`，`gatherTick` 仅在空槽且到点时 spawn。
> 2. **`ResourceNode` 增 `respawnMs` 字段**；`ResourceState.claim()` 返回被认领的 node（供发货）或 null。
> 3. **gatherService 不依赖 inventory**（便于单测）：`tryClaim(pid,rid)` 只做仲裁并返回 `{ ok, code?, grant?:{characterId,itemId,qty} }`；**发货由 router 在 ok 后调 `invGainItem`**。
> 4. 已落地文件：`domain/gather/{resourceState,spawnTable,gatherService}.ts`、`config.ts`、`util/schema.ts`(GatherClaim)、`gateway/router.ts`(装配+`gather.claim`+enterMap resources)、`test/{resourceState,gatherService}.test.ts`。typecheck=0、vitest 66/66、ReadLints 净。
> 下方 ③a/③b 原始代码块为初稿，**实现以 `src/domain/gather/*` 为准**；③c/③d 未动。

**目标：** 地上可采集物的存在性/刷新/发放收归服务端权威；宝宝走到资源点 → `gather.claim` → 服务端仲裁防双采 → 服务端库存发货 + 广播 despawn。
**架构：** 新增 `domain/gather`（每图 `ResourceState` 镜像 `mapState`，独立 tick flush `gather.delta`）；`gather.claim` RPC 校验+`inventoryService.gainItem`；客户端新增 `XdRs_Online_Gather.js` 把服务端资源镜像为 Arder 可 seek 的实体并把采集结算改为认领；数据管线从 `data/Map*.json` 提取资源槽位表。
**技术栈：** TypeScript + socket.io + zod + vitest（服务端）；RMMZ/NW.js（客户端）。

## 文件结构

服务端（`xiaoshagua-server/server/src/`）：
- 新增 `domain/gather/resourceState.ts`：每图资源态 + pending delta（类比 `mapState.ts`）。
- 新增 `domain/gather/gatherService.ts`：spawn/respawn 调度、claim 仲裁、tick flush、attachIo（类比 `worldService.ts`）。
- 新增 `domain/gather/spawnTable.ts`：槽位表类型 + 按 mapId 查询 + 从 JSON 加载。
- 改 `util/schema.ts`：`GatherClaim`（{ rid }）。
- 改 `gateway/router.ts`：`installRouter` 里 `attachGatherIo(io)+startGatherTick()`；注册 `socket.on('gather.claim')`；`player.enterMap` ack 附 `resources`。
- 改 `config.ts`：`gatherClaimRangeTiles`（默认 2）、`gatherTickMs`（默认=worldTickMs）。
- 新增 `scripts/extract-resources.ts`：扫 `data/Map*.json` 生成槽位表 JSON。
- 新增 `server/data/gather-spawn-table.json`：构建产物（③d）。
- 新增 `test/gatherService.test.ts`、`test/resourceState.test.ts`。

客户端（`xiaoshagua/js/plugins/`，镜像 `client-plugins/`）：
- 新增 `XdRs_Online_Gather.js`：订阅 `gather.delta` + enterMap `resources` 快照；维护资源镜像（被 `getResource/seekResource` 命中）；采集到点发 `gather.claim`；收 `claimed` 移除镜像。
- 改 `plugins.js`：注册 `XdRs_Online_Gather`（Arder + GatherAsync + Online 系列之后）。

统一类型：`ResourceNode { rid:number; mapId:number; x:number; y:number; itemId:number; kind:'item'; state:'active'|'claimed' }`；wire `gather.delta { seq, spawn:[{rid,x,y,itemId}], claimed:[{rid,byPid}] }`；`GatherClaim { rid:number }`。

---

## 任务

### ③a · 服务端资源层

#### A1 · resourceState.ts
**文件：** 新增 `server/src/domain/gather/resourceState.ts`
**步骤：**
```ts
export interface ResourceNode {
  rid: number; x: number; y: number; itemId: number; kind: 'item';
  state: 'active' | 'claimed';
}
export interface ResourceSpawnView { rid: number; x: number; y: number; itemId: number; }
export interface ResourceClaimView { rid: number; byPid: number; }
interface Pending { spawn: ResourceSpawnView[]; claimed: ResourceClaimView[]; }

export class ResourceState {
  readonly mapId: number;
  readonly nodes = new Map<number, ResourceNode>();
  private pending: Pending = { spawn: [], claimed: [] };
  seq = 0;
  constructor(mapId: number) { this.mapId = mapId; }

  spawn(node: ResourceNode): void {
    this.nodes.set(node.rid, node);
    this.pending.spawn.push({ rid: node.rid, x: node.x, y: node.y, itemId: node.itemId });
  }
  claim(rid: number, byPid: number): boolean {
    const n = this.nodes.get(rid);
    if (!n || n.state !== 'active') return false;
    n.state = 'claimed';
    this.pending.claimed.push({ rid, byPid });
    return true;
  }
  remove(rid: number): void { this.nodes.delete(rid); }
  drainDelta(): Pending | null {
    const d = this.pending;
    if (d.spawn.length === 0 && d.claimed.length === 0) return null;
    this.pending = { spawn: [], claimed: [] };
    return d;
  }
  snapshot(): ResourceSpawnView[] {
    const out: ResourceSpawnView[] = [];
    for (const n of this.nodes.values()) if (n.state === 'active') out.push({ rid: n.rid, x: n.x, y: n.y, itemId: n.itemId });
    return out;
  }
}
```
**验证：** `npm run typecheck`。
**提交：** `feat(server): gather ResourceState per-map delta accumulator`

#### A2 · spawnTable.ts（加载槽位表）
**文件：** 新增 `server/src/domain/gather/spawnTable.ts`
**步骤：**
```ts
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface SpawnSlot { x: number; y: number; itemId: number; respawnMs: number; }
export type SpawnTable = Record<number, SpawnSlot[]>; // mapId -> slots

const here = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(here, '../../../data/gather-spawn-table.json');

let table: SpawnTable = {};
export function loadSpawnTable(): SpawnTable {
  if (existsSync(TABLE_PATH)) {
    try { table = JSON.parse(readFileSync(TABLE_PATH, 'utf8')) as SpawnTable; }
    catch { table = {}; }
  }
  return table;
}
export function slotsForMap(mapId: number): SpawnSlot[] { return table[mapId] ?? []; }
```
**验证：** `npm run typecheck`（缺 JSON 时返回空表，不报错）。
**提交：** `feat(server): gather spawn-table loader`

#### A3 · gatherService.ts（调度 + 广播 + 认领）
**文件：** 新增 `server/src/domain/gather/gatherService.ts`
**步骤：**
```ts
import type { Server } from 'socket.io';
import { config } from '../../config.js';
import { getOnlineByPid } from '../player/playerService.js';
import { gainItem } from '../inventory/inventoryService.js';
import { room } from '../world/worldService.js';
import { ResourceState, type ResourceNode } from './resourceState.js';
import { loadSpawnTable, slotsForMap } from './spawnTable.js';

const states = new Map<number, ResourceState>();
let io: Server | null = null;
let tick: NodeJS.Timeout | null = null;
let ridSeq = 1;
// 每槽位下次可生成时间： key=`${mapId}:${x}:${y}`
const nextSpawnAt = new Map<string, number>();

export function attachGatherIo(s: Server): void { io = s; loadSpawnTable(); }
export function startGatherTick(): void {
  if (tick) return;
  tick = setInterval(gatherTick, config.gatherTickMs);
}
export function stopGatherTick(): void { if (tick) clearInterval(tick); tick = null; }

function stateOf(mapId: number): ResourceState {
  let st = states.get(mapId);
  if (!st) { st = new ResourceState(mapId); states.set(mapId, st); }
  return st;
}
export function snapshotForMap(mapId: number) { return stateOf(mapId).snapshot(); }

function gatherTick(): void {
  if (!io) return;
  const now = Date.now();
  // 仅对"有人"的地图调度（按 world room 是否有人由 worldService 决定；这里对所有已建 state 的图 + 槽位表所列图）
  for (const mapId of Object.keys(loadSpawnTable()).map(Number)) {
    const st = stateOf(mapId);
    const occupied = new Set<string>();
    for (const n of st.nodes.values()) if (n.state === 'active') occupied.add(`${n.x}:${n.y}`);
    for (const slot of slotsForMap(mapId)) {
      const key = `${mapId}:${slot.x}:${slot.y}`;
      if (occupied.has(`${slot.x}:${slot.y}`)) continue;
      const due = nextSpawnAt.get(key) ?? 0;
      if (now < due) continue;
      st.spawn({ rid: ridSeq++, x: slot.x, y: slot.y, itemId: slot.itemId, kind: 'item', state: 'active' });
      nextSpawnAt.set(key, now + slot.respawnMs);
    }
  }
  for (const st of states.values()) flushOne(st);
}

function flushOne(st: ReturnType<typeof stateOf>): void {
  if (!io) return;
  const d = st.drainDelta();
  if (!d) return;
  io.to(room(st.mapId)).emit('gather.delta', { seq: ++st.seq, spawn: d.spawn, claimed: d.claimed });
}

export interface ClaimResult { ok: boolean; code?: string; }
export function tryClaim(pid: number, rid: number): ClaimResult {
  const p = getOnlineByPid(pid);
  if (!p) return { ok: false, code: 'NO_AUTH' };
  const st = states.get(p.mapId);
  if (!st) return { ok: false, code: 'NO_SUCH_NODE' };
  const node = st.nodes.get(rid);
  if (!node || node.state !== 'active') return { ok: false, code: 'CLAIMED_BY_OTHER' };
  if (!inRange(p, node)) return { ok: false, code: 'OUT_OF_RANGE' };
  // 仲裁：先占位再发货，避免并发双采
  if (!st.claim(rid, pid)) return { ok: false, code: 'CLAIMED_BY_OTHER' };
  gainItem(p.pid, 'item', node.itemId, 1, 'gather');
  st.remove(rid); // 已 claimed，移出活跃集（despawn 已入 pending.claimed 广播）
  return { ok: true };
}

function inRange(p: { x: number; y: number; followers?: { x: number; y: number }[] }, node: ResourceNode): boolean {
  const r = config.gatherClaimRangeTiles;
  const near = (ax: number, ay: number) => Math.abs(ax - node.x) <= r && Math.abs(ay - node.y) <= r;
  if (near(p.x, p.y)) return true;
  for (const f of p.followers ?? []) if (near(f.x, f.y)) return true; // 宝宝在范围内也算
  return false;
}
```
**验证：** `npm run typecheck`。
**提交：** `feat(server): gatherService spawn/respawn + claim arbitration + delta flush`

### ③b · 接入网关 + 协议

#### B1 · schema GatherClaim
**文件：** 改 `server/src/util/schema.ts`
**步骤：**
```ts
export const GatherClaim = z.object({ rid: z.number().int().positive() });
```
**验证：** `npm run typecheck`。
**提交：** `feat(server): GatherClaim schema`

#### B2 · config 字段
**文件：** 改 `server/src/config.ts`
**步骤：** 在 config 对象按现有字段风格加：
```ts
  gatherTickMs: Number(process.env.GATHER_TICK_MS ?? '') || /* 复用 */ 0, // 0 时回退 worldTickMs（在 startGatherTick 里兜底）
  gatherClaimRangeTiles: Number(process.env.GATHER_CLAIM_RANGE ?? '') || 2,
```
（`startGatherTick` 用 `config.gatherTickMs || config.worldTickMs`）
**验证：** `npm run typecheck`。
**提交：** `feat(server): gather config (tick, claim range)`

#### B3 · router 装配 + gather.claim + enterMap 快照
**文件：** 改 `server/src/gateway/router.ts`
**步骤：**
- import：`import { attachGatherIo, startGatherTick, tryClaim, snapshotForMap } from '../domain/gather/gatherService.js';` 与 `GatherClaim`。
- `installRouter` 内（`attachIo(io)`/`startTick()` 旁，约 :183/:188）加 `attachGatherIo(io); startGatherTick();`。
- `player.enterMap` 的 ack：把 `snapshot` 与资源合并返回——`cb?.(okAck({ ...snapshot, resources: snapshotForMap(input.mapId) }));`（snapshot 现为 `{ mapId, others }`，扩成含 `resources`）。
- 新增 handler（范式同 `player.move`，但带 ack）：
```ts
    socket.on('gather.claim', (raw, ack) => {
      const cb = safeAck(ack);
      try {
        if (!takeToken(socket)) throw new AppError('RATE_LIMIT', 'too many requests');
        const session = socket.session;
        if (!session.authed || session.pid === null) throw new AppError('NO_AUTH', 'login required');
        const input = parse(GatherClaim, raw);
        const r = tryClaim(session.pid, input.rid);
        cb?.(r.ok ? okAck({ rid: input.rid }) : failAck(r.code ?? 'CLAIM_FAILED'));
      } catch (err) { sendError(socket, cb, err); }
    });
```
**验证：** `npm run typecheck`。
**提交：** `feat(server): wire gather (tick + gather.claim + enterMap resources)`

#### B4 · 服务端单测
**文件：** 新增 `server/test/resourceState.test.ts` + `server/test/gatherService.test.ts`
**步骤：**
- resourceState：spawn 进 snapshot；claim active→true、再 claim→false；drainDelta 累积后清空。
- gatherService：构造两个在线玩家（mock `getOnlineByPid` 或经 worldService.enterMap 注入），同 rid 两次 `tryClaim` → 仅第一成功、第二 `CLAIMED_BY_OTHER`；超距 `tryClaim` → `OUT_OF_RANGE`。
```ts
// gatherService.test.ts 关键断言
const r1 = tryClaim(pidA, rid); const r2 = tryClaim(pidB, rid);
expect(r1.ok).toBe(true); expect(r2).toEqual({ ok: false, code: 'CLAIMED_BY_OTHER' });
```
**验证：** `cd xiaoshagua-server/server && npm test`（新用例通过、无回归）。
**提交：** `test(server): cover gather claim arbitration & range`

### ③c · 客户端集成（最高风险，G1：镜像 + 改结算）

> 设计 §5.2/§5.3。本组**实现时需对照活文件 `XdRs_GatherAsync.js`（800+ 行）**确认 splice 点：采集完成发货在 `cmd_gainItem`(:496→`$gameParty.gainItem` :500/506/512) 与频道完成(:720 附近)。下列为目标行为与挂点，落地时按实际函数名微调。

#### C1 · 新增 XdRs_Online_Gather.js（资源镜像）
**文件：** 新增 `xiaoshagua/js/plugins/XdRs_Online_Gather.js`
**步骤（要点）：**
- 进图：`Net.on('world... ')` 不动；在 enterMap 的 ack（PlayerSync 已有 `.then(snap=>...)`）扩展不便，故本插件单独 `Net.on('gather.delta', applyDelta)`，并在 `Scene_Map.start` 后用现成的 enterMap ack `snap.resources` 初始化（通过 `window.XdRsOnline.PlayerSync` 暴露的 hook 或本插件自发一次 `gather.sync` —— 实现时二选一，优先复用 snap.resources）。
- 维护 `Map<rid, {x,y,itemId}>` 与 tile→rid 索引。
- 镜像为可被 Arder `Game_Map.getResource`/`Game_Follower.seekResource` 命中的实体：在对应 tile 放/撤「资源事件代理」（复用 `<Resource>` 事件可见性，或生成轻量资源精灵 + 让 `getResource` 也扫描本镜像集——实现时择一，优先让 `getResource` 兼容扫描镜像集，避免改 RMMZ 事件系统）。
- `gather.delta.claimed` / 自己认领成功 → 移除该 rid 镜像；宝宝若锁定它则触发 `clearResourceEvent` 重选。
**验证：** `node --check XdRs_Online_Gather.js`。
**提交：** `feat(client): XdRs_Online_Gather mirror server resources`

#### C2 · 采集结算改认领
**文件：** 改 `xiaoshagua/js/plugins/XdRs_GatherAsync.js`（或在 `XdRs_Online_Gather.js` 内 hook）
**步骤（要点）：**
- 采集到点结算时，若该资源是服务端镜像（tile 命中 rid）：**不**本地 `$gameParty.gainItem`，改 `window.XdRsOnline.Net.request('gather.claim',{rid})`。
- 成功：本地播采集成功表现（SE/气泡），**不造物**（物品由服务端库存增量推送到账）。
- 失败 `CLAIMED_BY_OTHER`：移除镜像、宝宝重选目标、可播一个「慢了一步」轻提示。
- 非服务端资源（无 rid，纯单机 `<Resource>`）：保持原本地 `gainItem` 行为不变（向后兼容、③ 未铺满的图照旧）。
**验证：** `node --check`；运行期实测（见汇总）。
**提交：** `feat(client): route server-managed gather pickup through claim`

#### C3 · 注册 + 镜像
**文件：** 改 `xiaoshagua/js/plugins.js`（注册 `XdRs_Online_Gather`）；镜像两个客户端文件到 `xiaoshagua-server/client-plugins/`
**验证：** `node --check` 两份；`plugins.js` `node --check`；`fc` 镜像一致。
**提交：** `chore(client): register + mirror XdRs_Online_Gather & GatherAsync`

### ③d · 数据管线

#### D1 · extract-resources.ts
**文件：** 新增 `server/scripts/extract-resources.ts`
**步骤（要点）：**
- 用 `node:fs` 读 `../../xiaoshagua/data/Map*.json`（路径相对脚本，实现时确认仓库相对位置）。
- 对每个 map：遍历 `events`，事件 `note` 含 `<Resource>` 者取 `{x,y}`；扫其 pages[].list 找 `code===126`（改变物品）取 dataId 作为 `itemId`；respawnMs 用默认 `1_800_000`（30 分钟，对齐已锁定决策；缺省由 `config.gatherDefaultRespawnMs` 兜底），可后续按 note 标签逐点覆盖。
- 产出 `{ [mapId]: [{x,y,itemId,respawnMs}] }` 写 `server/data/gather-spawn-table.json`。
**验证：** `tsx scripts/extract-resources.ts` 跑通；输出 JSON 含 ≥1 个 map 且每槽位有 itemId；`node -e` 校验 JSON.parse 合法。
**提交：** `feat(server): extract <Resource> slots from Map*.json into spawn table`

### 收尾

#### E1 · 全量校验
**步骤：** 服务端 `npm run typecheck && npm test`；客户端三份新增/改动 `node --check`；全部改动文件 ReadLints；镜像 `fc` 一致。修掉一切错误。
**提交：** `chore: typecheck/test/lint pass for cloud-shared-gather`

---

## 验证（上线前汇总，对应设计 §10）

- 服务端：`npm run typecheck`=0；`npm test` 全绿（含 resourceState/gatherService 新用例：抢同 rid 仅一胜、超距拒绝、respawn）。
- 数据管线：`tsx scripts/extract-resources.ts` 产出合法槽位表。
- 客户端：`node --check` 全过；镜像一致。
- 运行期实测：两客户端宝宝抢同 node → 仅一方得物、另一方收 `CLAIMED_BY_OTHER` 并重选；respawn 节奏全员一致；进图快照重建资源；服务端重启按槽位表重生；库存只由服务端增量到账（客户端不造物）。

## 计划自检

- **规格覆盖**：设计 §4→A1/A2/A3；§5→B1/B3+C2；§6→A3(gatherTick)+D1；§7→D1；§8→A3(内存态)；§9→A3(inRange)+C2(失败重选)；§10→B4/E1/汇总。
- **占位符**：服务端步骤含完整代码；**③c 客户端为目标行为+挂点描述**（GatherAsync 800+ 行，splice 细节实现时对照活文件定稿，已在 ③c 抬头显式标注），这是已知的"实现时确认"项，非遗漏。
- **类型一致**：`ResourceNode`/`ResourceSpawnView`/`GatherClaim`/`gather.delta` 字段贯穿 A1/A3/B1/B3；`tryClaim(pid,rid)` 定义(A3)与调用(B3)一致；`gainItem(characterId,'item',itemId,1,'gather')` 与 inventoryService 签名一致。
- **风险**：③c 为最高风险；建议 ③a/③b/③d 先落地并单测通过，再单独推进 ③c（可独立成更细计划）。
