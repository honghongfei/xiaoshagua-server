# 本体宝宝·在线挂机采集 + 联机可见 实现计划

> **面向 AI 代理的工作者：** 用 executing-plans 逐任务实现。完整设计与论证见 `../specs/2026-06-19-native-pet-afk-visibility-design.md`，本计划只列可执行步骤与验证，不重复设计。③ 地上物云端共享是独立计划（暂未生成）。

**目标：** ① 客户端在线且在地图时，失焦/挂后台让本体宝宝（`Game_Follower`）继续自动采集；② 把本机可见宝宝广播给同图玩家并渲染他人的宝宝。
**架构：** ① 新增插件 hook `SceneManager.isGameActive`，仅「在线 + Scene_Map + 开关开」放行失焦 update；② 在现有 `player.move`/`player.enterMap` 负载附 `followers` 数组，服务端透传，客户端复用 `Sprite_OtherPlayer`（无名字）渲染远端宝宝。
**技术栈：** RMMZ/NW.js 客户端插件；TypeScript + socket.io + zod + vitest 服务端。

## 文件结构

客户端（`xiaoshagua/js/plugins/`，每个改动都镜像到 `xiaoshagua-server/client-plugins/`）：
- 新增 `XdRs_AfkGather.js`：① 焦点门控放行 + `Game_System` 开关 + 插件命令切换。
- 改 `plugins.js`：注册 `XdRs_AfkGather`（放 Arder 与 Online 系列之后）。
- 改 `XdRs_Online_PlayerSync.js`：② 广播侧（采集 followers、扩 lastSent、扩 enterMap）+ 渲染侧（`Sprite_OtherPlayer` 支持无名字、`addOther`/`removeOther`/`world.delta.move` 处理 followers）。

服务端（`xiaoshagua-server/server/src/`）：
- 改 `util/schema.ts`：`Follower` zod + `PlayerMove`/`PlayerEnterMap` 增 `followers?`。
- 改 `domain/player/playerService.ts`：定义 `FollowerView`、`OnlinePlayer.followers`、`markOnline` 接收 followers。
- 改 `domain/world/mapState.ts`：`MoveDelta.followers?`、`RemotePlayerView.followers`、`applyMove(...,followers?)`、`toView` 透传。
- 改 `domain/world/worldService.ts`：`moveOnMap(...,followers?)`。
- 改 `gateway/router.ts`：`player.move` 传 followers；`player.enterMap` 的 `markOnline` 带 followers。
- 改 `test/mapState.test.ts`：followers 透传单测。

统一类型（贯穿前后端，wire 与 view 同形）：`Follower = { x:int; y:int; d:2|4|6|8; charSet:string|null; charIndex:int(0..7) }`。

---

## 任务

### A1 · 新增 `XdRs_AfkGather.js`（① 门控 + 开关）
**文件：** 新增 `xiaoshagua/js/plugins/XdRs_AfkGather.js`
**步骤：**
```js
//=============================================================================
// XdRs_AfkGather.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 在线挂机采集：联机+地图时失焦也继续 update，让本体宝宝挂后台自动采集
 * @author xsg-online
 * @help 仅当「已联机 + 当前 Scene_Map + 开关开(默认开)」时放行失焦 update。
 *   插件命令 ToggleAfkGather 可开关；$gameSystem.afkGatherEnabled() 读状态。
 * @command ToggleAfkGather
 * @text 开关挂机采集
 *
 * @param afkFpsDivider
 * @type number @min 1 @default 1
 * @text 失焦降帧分频(1=满帧)
 */
(() => {
  'use strict';
  const pluginName = 'XdRs_AfkGather';

  Game_System.prototype.afkGatherEnabled = function () {
    return this._afkGather !== false; // 默认开
  };
  Game_System.prototype.setAfkGather = function (on) {
    this._afkGather = !!on;
  };

  const _isActive = SceneManager.isGameActive;
  SceneManager.isGameActive = function () {
    const N = window.XdRsOnline && window.XdRsOnline.Net;
    if (N && N.isConnected && N.isConnected()
        && this._scene instanceof Scene_Map
        && $gameSystem && $gameSystem.afkGatherEnabled && $gameSystem.afkGatherEnabled()) {
      return true;
    }
    return _isActive.call(this);
  };

  PluginManager.registerCommand(pluginName, 'ToggleAfkGather', () => {
    $gameSystem.setAfkGather(!$gameSystem.afkGatherEnabled());
  });
})();
```
**验证：** `node --check xiaoshagua/js/plugins/XdRs_AfkGather.js`（语法通过）。
**提交：** `feat(client): add XdRs_AfkGather focus-gate for online AFK pet gather`

### A2 · 注册插件
**文件：** 改 `xiaoshagua/js/plugins.js`
**步骤：** 在 `$plugins` 数组中、`XdRs_Arder_*` 与 `XdRs_Online_*` 之后，新增一项：
```js
{"name":"XdRs_AfkGather","status":true,"description":"在线挂机采集","parameters":{"afkFpsDivider":"1"}}
```
**验证：** `node -e "require('fs');new Function(require('fs').readFileSync('xiaoshagua/js/plugins.js','utf8'));console.log('ok')"`（`$plugins` 赋值可解析）。
**提交：** `feat(client): register XdRs_AfkGather in plugins.js`

### A3 · 镜像 AfkGather 到 client-plugins
**文件：** 新增 `xiaoshagua-server/client-plugins/XdRs_AfkGather.js`（与 A1 完全一致）
**验证：** 两份 `node --check` 均通过；`fc` 比对一致。
**提交：** `chore(mirror): sync XdRs_AfkGather to client-plugins`

### B1 · 广播侧：采集并上报 followers
**文件：** 改 `xiaoshagua/js/plugins/XdRs_Online_PlayerSync.js`
**步骤：** 在移动上报区（现 :118-135）前加采集辅助，并扩展上报与 lastSent：
```js
// followers 采集（仅可见跟随者；口径对齐玩家 _x|0/_y|0/direction）
function collectFollowers() {
  const out = [];
  const data = $gamePlayer && $gamePlayer._followers && $gamePlayer._followers._data;
  if (!data) return out;
  for (const f of data) {
    if (!f || !f.isVisible || !f.isVisible()) continue;
    out.push({
      x: f._x | 0, y: f._y | 0, d: f.direction(),
      charSet: (f.characterName && f.characterName()) || null,
      charIndex: (f.characterIndex && (f.characterIndex() | 0)) || 0,
    });
  }
  return out;
}
function followersSig(fs) {
  return fs.map((f) => f.x + ',' + f.y + ',' + f.d + ',' + f.charSet + ',' + f.charIndex).join('|');
}
```
把 `Game_Player.prototype.update` 覆盖（:122-135）改为并入 followers 变更检测：
```js
  let lastSentFol = '';
  const _Game_Player_update = Game_Player.prototype.update;
  Game_Player.prototype.update = function (sceneActive) {
    _Game_Player_update.call(this, sceneActive);
    if (!Core.isOnline()) return;
    const now = Util.now();
    if (now - lastReport < reportIntervalMs) return;
    const x = this._x | 0, y = this._y | 0, d = this.direction();
    const followers = collectFollowers();
    const folSig = followersSig(followers);
    if (x === lastSent.x && y === lastSent.y && d === lastSent.d && folSig === lastSentFol) return;
    lastSent = { x, y, d }; lastSentFol = folSig; lastReport = now;
    const payload = { x, y, d, ts: now };
    if (followers.length) payload.followers = followers;
    Net.emit('player.move', payload);
  };
```
在 `enterCurrentMap` 的 `payload`（:159-163）后追加：
```js
    const fol = collectFollowers();
    if (fol.length) payload.followers = fol;
```
**验证：** `node --check xiaoshagua/js/plugins/XdRs_Online_PlayerSync.js`。
**提交：** `feat(client): broadcast follower transforms in player.move/enterMap`

### C1 · 渲染侧：Sprite_OtherPlayer 支持「无名字」复用
**文件：** 改 `XdRs_Online_PlayerSync.js`（`ensureOtherPlayerClass` 内）
**步骤：** 让 `Sprite_OtherPlayer` 构造函数接收第二参 `opts`，当 `opts && opts.withName === false` 时**跳过**创建/更新 `_nameSprite`（其余位置/贴图逻辑不变）。这样 follower 复用同一类、零重复实现。
```js
// 构造：function Sprite_OtherPlayer(view, opts){ this._noName = !!(opts && opts.withName === false); ... }
// 创建名字处：if (!this._noName) { /* 原 _nameSprite 创建逻辑 */ }
// 更新/销毁名字处同样用 if (!this._noName) 包裹
```
**验证：** `node --check`。
**提交：** `refactor(client): Sprite_OtherPlayer supports nameless mode for followers`

### C2 · 渲染侧：addOther/move/removeOther 处理 followers
**文件：** 改 `XdRs_Online_PlayerSync.js`
**步骤：**
- `addOther(view)`（:180-194）末尾追加：
```js
    sp._followers = [];
    if (Array.isArray(view.followers)) {
      for (const fv of view.followers) {
        const fsp = new window.Sprite_OtherPlayer(fv, { withName: false });
        sp._followers.push(fsp);
        if (ss._characterSprites) ss._characterSprites.push(fsp);
        if (ss._tilemap) ss._tilemap.addChild(fsp);
      }
    }
```
- `world.delta` 的 move 分支（:240-247）内、对 `sp` 应用后追加：
```js
        if (Array.isArray(m.followers)) syncOtherFollowers(sp, m.followers, ss);
```
并新增辅助（计数变化则重建，否则逐个 applyRemoteMove）：
```js
  function syncOtherFollowers(sp, fols, ss) {
    if (!sp._followers) sp._followers = [];
    if (sp._followers.length !== fols.length) {
      for (const old of sp._followers) {
        if (ss && ss._characterSprites) { const i = ss._characterSprites.indexOf(old); if (i>=0) ss._characterSprites.splice(i,1); }
        if (old.parent) old.parent.removeChild(old);
        if (typeof old.destroy === 'function') old.destroy();
      }
      sp._followers = fols.map((fv) => {
        const fsp = new window.Sprite_OtherPlayer(fv, { withName: false });
        if (ss && ss._characterSprites) ss._characterSprites.push(fsp);
        if (ss && ss._tilemap) ss._tilemap.addChild(fsp);
        return fsp;
      });
    } else {
      fols.forEach((fv, i) => sp._followers[i].applyRemoteMove(fv.x, fv.y, fv.d));
    }
  }
```
- `removeOther(pid)`（:196-207）与 `destroyOtherSprite(sp)`（:215-229）：在销毁玩家 sprite 前，对 `sp._followers` 逐个从 `_characterSprites` 摘除、`removeChild`、`destroy`，然后 `sp._followers = null`。
**验证：** `node --check`；运行期肉眼验证（双客户端，见汇总）。
**提交：** `feat(client): render & lifecycle remote followers`

### C3 · 镜像 PlayerSync 到 client-plugins
**文件：** 同步 `xiaoshagua-server/client-plugins/XdRs_Online_PlayerSync.js` = 客户端版
**验证：** 两份 `node --check` + `fc` 一致。
**提交：** `chore(mirror): sync PlayerSync follower changes`

### D1 · schema：followers 校验
**文件：** 改 `xiaoshagua-server/server/src/util/schema.ts`
**步骤：**
```ts
const Dir = z.number().int().refine((v) => v === 2 || v === 4 || v === 6 || v === 8, { message: 'd must be 2/4/6/8' });
const Follower = z.object({
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  d: Dir,
  charSet: z.string().max(64).nullable().optional(),
  charIndex: z.number().int().min(0).max(7).optional(),
});
// PlayerEnterMap、PlayerMove 各加一行：
//   followers: z.array(Follower).max(8).optional(),
```
**验证：** `cd xiaoshagua-server/server && npm run typecheck`。
**提交：** `feat(server): accept followers in player.move/enterMap schema`

### D2 · player 领域：FollowerView 与 OnlinePlayer.followers
**文件：** 改 `server/src/domain/player/playerService.ts`
**步骤：**
```ts
export interface FollowerView { x: number; y: number; d: number; charSet: string | null; charIndex: number; }
// OnlinePlayer 接口加： followers?: FollowerView[];
// markOnline 入参类型加 followers?: FollowerView[]，并在建立 OnlinePlayer 时写入 followers: input.followers ?? []
```
**验证：** `npm run typecheck`。
**提交：** `feat(server): OnlinePlayer carries followers`

### D3 · mapState：透传 followers
**文件：** 改 `server/src/domain/world/mapState.ts`
**步骤：**
```ts
import type { OnlinePlayer, FollowerView } from '../player/playerService.js';
// MoveDelta 加： followers?: FollowerView[];
// RemotePlayerView 加： followers: FollowerView[];
// toView：返回对象加 followers: p.followers ?? [],
// applyMove 签名改 (pid, x, y, d, followers?: FollowerView[])：
//   p.followers = followers ?? p.followers ?? [];
//   this.pending.move.set(pid, { pid, x, y, d, followers: p.followers });
```
**验证：** `npm run typecheck`。
**提交：** `feat(server): mapState relays followers in delta & snapshot`

### D4 · worldService + router：把 followers 串起来
**文件：** 改 `server/src/domain/world/worldService.ts`、`server/src/gateway/router.ts`
**步骤：**
- worldService：`moveOnMap(pid, x, y, d, followers?: FollowerView[])` → `map.applyMove(pid, x, y, d, followers)`（import `FollowerView`）。
- router `player.move`（:332-346）：`moveOnMap(session.pid, input.x, input.y, input.d, input.followers)`。
- router `player.enterMap` 的 `markOnline({...})`（:302-316）增 `followers: input.followers ?? []`。
**验证：** `npm run typecheck`。
**提交：** `feat(server): wire followers through move & enterMap`

### D5 · 服务端单测
**文件：** 改 `server/test/mapState.test.ts`
**步骤：** 新增用例：
```ts
it('relays followers in move delta and snapshot', () => {
  const m = new MapState(1);
  const p: any = { pid: 7, name: 'A', actorId: 1, x: 1, y: 1, d: 2, charSet: 'P', charIndex: 0, level: 1 };
  m.add(p);
  const fol = [{ x: 2, y: 1, d: 4, charSet: 'Pet', charIndex: 1 }];
  m.applyMove(7, 2, 1, 4, fol as any);
  const d = m.drainDelta()!;
  expect(d.move.get(7)!.followers).toEqual(fol);
  m.add(p);
  expect(m.snapshotFor(99)[0].followers).toEqual(fol);
});
```
**验证：** `cd xiaoshagua-server/server && npm test`（该用例通过、无回归）。
**提交：** `test(server): cover followers relay in mapState`

### E1 · 收尾校验
**步骤：** 对所有改动文件跑 ReadLints；服务端 `npm run typecheck && npm test`；客户端两份插件 `node --check`。修掉任何 lint/类型错误。
**提交：** `chore: lint & typecheck pass for native-pet afk+visibility`

---

## 验证（上线前汇总，对应设计 §7）

- 语法/类型：客户端 `XdRs_AfkGather.js`、`XdRs_Online_PlayerSync.js`（含两份镜像）`node --check` 全过；服务端 `npm run typecheck`、`npm test` 全绿。
- ① 实测：登录联机进地图 → alt-tab 失焦 → 宝宝持续移动并采集、背包增长；切菜单/战斗失焦应冻结；断线后失焦应回冻结；`afkFpsDivider>1` 时 CPU 实测下降。
- ② 实测：两客户端同图 → A 能看到 B 的宝宝随 B 移动、采集脱队走动；B 宝宝进化后 A 端形象更新（followers 带 charSet/charIndex，变形即触发上报）；B 离场/切图后 A 端其宝宝精灵全部清除（无 Bitmap 泄漏）。

## 计划自检

- **规格覆盖**：设计 §4 ①→A1/A2/A3；§5.2 广播→B1；§5.3 渲染→C1/C2；§5.4 进化形象→由 followers 始终带 charSet/charIndex + 变更触发覆盖；§5.5 服务端→D1-D4；§7 测试→D5/E1/汇总。降帧 §4.3 作为 `afkFpsDivider` 参数预留（满帧默认，渲染分频可后续接 `SceneManager.renderScene`，不阻塞本计划）。
- **占位符**：无 TODO/待定；每步含实际代码或精确改动位置。
- **类型一致**：`Follower`(zod) / `FollowerView`(server) / 客户端 followers 条目三处字段同名同义（x,y,d,charSet,charIndex）；`applyMove(pid,x,y,d,followers?)` 在 D3 定义、D4 调用一致。
