# 存档锁账号设计（Save-Account Lock）

- 日期：2026-06-18
- 方案：B（客户端门禁 + 服务端兜底）
- 威胁模型：**普通朋友直接拷贝存档文件**（非技术型、不会改客户端/手改存档/构造请求）
- 状态：待用户审查

## 1. 背景与问题

云存档系统当前现状（已读代码确认）：

- 云存档按 `character_id` 存一行 `contents`（`server/src/domain/storage/storageService.ts` 的 `savefile_cloud` UPSERT）。
- `save.upload` 服务端用的是会话里的 `s.pid`（登录时 `bindSession` 绑定的角色 id），**不是客户端传入的 id** —— 所以无法通过接口上传到别人的槽位。
- **真正漏洞**：存档的**内容本身没有归属信息**。一份"肥号"本地存档文件（`save/fileN.rmmzsave`）可以被复制给任意人，对方放进自己的 `save/` 目录后，通过"存档迁移"面板一键上传，就把里面的金币/物品搬进了自己的账号。

### 关键破坏点

`XdRs_Online_SaveMigrate.js` 的 `uploadSlotToCloud(savefileId)` 顺序是：

1. 读本地槽 → 抽出 `_gold / _items / _weapons / _armors`
2. **先调 `inventory.replace`**（把金币/物品**全量覆盖**服务端权威表 `character.gold` / inventory）
3. 再调 `save.upload`（写云档 blob）

所以白嫖的真正动作是第 2 步：`inventory.replace` 直接把上传者账号的**权威资产**刷成被拷存档里的值。因此**归属校验必须卡在第 2 步 `inventory.replace` 之前**。

## 2. 目标 / 非目标

**目标**

- 一份存档只能被它所属的账号（角色 pid）上传到云端；别人账号上传 → 拒绝，且不触发 `inventory.replace`。
- 老的单机存档（无归属信息）首次在某账号下迁移时，绑定给该账号（TOFU，trust-on-first-use）。
- 服务端对所有 `save.upload` 兜底校验，防"绕过客户端 UI 仍上传真·别人存档"。

**非目标（YAGNI）**

- 不防"会手改存档/改客户端/构造请求"的技术型攻击者（不做 HMAC 签名）。
- 不做内容哈希查重（新手开局存档高度雷同，会误杀正常玩家）。
- 不做本地读取门禁（原设计第 4 项已砍——读档是最不该失败的操作，加门禁会引入"读不了自己存档"的风险且对线上经济无收益）。

## 3. 数据模型

在存档 `contents` 顶层加一个归属章字段：

```
contents.xsgOwner = {
  v: 1,                 // 版本，便于将来演进
  pid: <number>,        // 归属角色 id（= 服务端 s.pid，与云档 key 一致）
  accountId: <number|null>, // 归属账号 id（若客户端会话可得；仅展示用）
  at: <number>          // 盖章时间戳 ms
}
```

- `contents` 是 `DataManager.makeSaveContents()` 返回的普通对象；新增顶层字段不影响 RMMZ 的 `extractSaveContents`（只读已知键，忽略多余键）。
- `JsonEx.stringify` 输出是合法 JSON（内部基于 `JSON.stringify`），服务端可用 `JSON.parse` 读出 `xsgOwner.pid`，无需反序列化 RMMZ 类。

## 4. 详细设计

### 4.1 盖章（客户端，覆盖所有在线保存）

Hook `DataManager.makeSaveContents`：

```
const _makeSaveContents = DataManager.makeSaveContents;
DataManager.makeSaveContents = function () {
  const contents = _makeSaveContents.call(this);
  const G = window.XdRsOnline;
  const pid = G && G.Core && G.Core.session && G.Core.session.character
    ? G.Core.session.character.pid : null;
  if (G && G.Core && G.Core.isOnline() && typeof pid === 'number') {
    const acctId = (G.Core.session.character.accountId != null)
      ? G.Core.session.character.accountId : null; // 仅展示用，校验只认 pid
    contents.xsgOwner = { v: 1, pid, accountId: acctId, at: Date.now() };
  }
  return contents;
};
```

- 仅登录态盖章；离线存档不盖（保证离线读档/玩法不受影响）。
- 覆盖范围：`SaveCloud` 的自动同步 / 手动 saveGame / beforeunload 都经 `makeSaveContents`（`SaveCloud.buildContentsForUpload` 调的就是它），自动带章。
- 放在一个早加载、被各模块依赖的插件里（建议新建 `XdRs_Online_SaveOwner.js`，在 Core 之后、SaveCloud/SaveMigrate 之前加载），避免重复 hook。

### 4.2 客户端上传门禁（SaveMigrate，卡在 inventory.replace 之前）

改 `uploadSlotToCloud(savefileId)`，在第 2 步 `inventory.replace` **之前**插入：

```
const myPid = G.Core.session?.character?.pid;
const owner = contents.xsgOwner;
if (owner && typeof owner.pid === 'number' && owner.pid !== myPid) {
  throw new Error('此存档属于其他账号（owner=' + owner.pid + '），无法上传');
}
if (!owner) {
  // TOFU：老存档无章 → 当场绑定给当前账号（accountId 仅展示用，校验只认 pid）
  const acctId = (G.Core.session.character.accountId != null)
    ? G.Core.session.character.accountId : null;
  contents.xsgOwner = { v: 1, pid: myPid, accountId: acctId, at: Date.now() };
  // best-effort 写回本地文件，让这份存档以后被拷也已带章；失败不阻断上传
  try { await StorageManager.saveObject(DataManager.makeSavename(savefileId), contents); } catch (e) {}
}
// 注意：contentsStr 必须在盖章之后再 JsonEx.stringify
```

- `SaveMigrate` 读盘的存档不经 `makeSaveContents`，所以必须在此显式校验/盖章。
- 校验失败时抛错 → 现有 `onUploadClick` 的 try/catch 会显示"上传失败: ..."，**不会执行后续 `inventory.replace` 与 `save.upload`**。

### 4.3 服务端兜底（单一 choke point：uploadSave）

在 `server/src/domain/storage/storageService.ts` 的 `uploadSave(characterId, contents, ...)` 开头加：

```
function assertSaveOwner(contents: string, characterId: number): void {
  let owner: any;
  try { owner = (JSON.parse(contents) as any)?.xsgOwner; }
  catch { return; } // contents 非法 JSON：跳过归属校验（fail-open，不误伤）
  if (owner && typeof owner.pid === 'number' && owner.pid !== characterId) {
    throw new AppError('SAVE_FOREIGN',
      `cloud save owner mismatch (save=${owner.pid}, you=${characterId})`);
  }
}
```

- 在 `uploadSave` 里、写库之前调用 `assertSaveOwner(contents, characterId)`。
- 选 `uploadSave` 作为唯一拦截点，因为 socket `save.upload` 与（若存在的）beforeunload HTTP beacon 都应经此函数。实现时需确认 beacon 路径也走 `uploadSave`；若不走，补同一校验。
- `meta`/额外 payload 字段不作为归属依据（客户端可伪造）；只认 `contents` 内的 `xsgOwner`。

### 4.4 错误码

新增 `SAVE_FOREIGN`：上传的存档归属与当前账号不符。客户端展示中文提示。与现有 `SAVE_STALE`（乐观并发）并存、互不影响。

## 5. 老存档 / 多开 / 回滚

- **老存档 TOFU**：谁先在自己账号迁移上传，就绑给谁。普通朋友不会去"抢跑"同一份未盖章文件，可接受。
- **多开兼容**：每个客户端实例登录各自账号，`makeSaveContents` 按各自 pid 盖章；多开本身不破坏锁定。多开是独立功能，另开规格。
- **回滚**：`xsgOwner` 是附加字段，不影响读档；服务端只在"有章且不符"时拒绝。回滚 = 删除 4.1/4.2/4.3 的检查代码，已盖章存档仍可正常读写。低风险。

## 6. 边界与风险

- **JSON.parse 2MB**：每次 `save.upload` 解析一次 contents；上传非高频，性能可接受。解析失败 fail-open，不阻断。
- **pid 取不到**（未登录态触发保存）：不盖章、不校验，按离线处理。
- **SaveCloud 正常上传**：内容由当前登录玩家 `makeSaveContents` 生成，`xsgOwner.pid` == `s.pid`，服务端校验通过，不影响既有同步。
- **既有云档**（升级前已上传、无章）：服务端 fail-open 放行；玩家下次在线保存即补章。

## 7. 测试计划

服务端（`server/test/`，vitest）：

- `uploadSave`：contents 带 `xsgOwner.pid === characterId` → 通过。
- `uploadSave`：contents 带 `xsgOwner.pid !== characterId` → 抛 `SAVE_FOREIGN`。
- `uploadSave`：contents 无 `xsgOwner` → 通过（兼容老档）。
- `uploadSave`：contents 非法 JSON → 不抛归属错（fail-open），其余校验照常。
- `uploadSave`：`xsgOwner.pid` 非 number（脏数据）→ 不误杀。

客户端（手测脚本/联机自测）：

- 自己的存档（带本账号章）上传 → 成功。
- 拷贝他人带章存档 → 上传被拦，且**未发生 `inventory.replace`**（服务端权威资产不变）。
- 老存档（无章）首次上传 → 成功并写回本地章；再被拷给他人上传 → 被拦。

## 8. 影响面 / 改动文件

客户端（`xiaoshagua/js/plugins/`，并镜像到 `xiaoshagua-server/client-plugins/`）：

- 新增 `XdRs_Online_SaveOwner.js`（4.1 盖章 hook），注册进 `plugins.js`（Core 之后、SaveCloud/SaveMigrate 之前）。
- 改 `XdRs_Online_SaveMigrate.js` `uploadSlotToCloud`（4.2 门禁 + TOFU）。

服务端（`xiaoshagua-server/server/src/`）：

- 改 `domain/storage/storageService.ts`：`uploadSave` 加 `assertSaveOwner`。
- `util/errors.ts`：确认 `SAVE_FOREIGN` 错误码可用（沿用 `AppError(code,msg)` 即可，无需枚举）。
- `server/test/storageService.test.ts`：补 5 个用例。

## 9. 验证方法（上线前）

- 服务端：`npm run typecheck` 0、`npm test` 全绿（含新用例）、`npm run build` 0。
- 客户端：`node --check` 两个改动文件、`plugins.js` JSON 合法、ReadLints 无错。
- 联机自测：按第 7 节客户端三场景跑一遍。
- 部署：服务端走已验证的 `_deploy-live.js`（git pull 快进 + build + pm2 重启 + healthz）；客户端需重打包分发（用户手动）。

## 10. 部署生效条件

- 服务端兜底（4.3）部署后即对**带章**上传生效；对老客户端（不发章）fail-open。
- 客户端门禁（4.1/4.2）需重打包分发给玩家后才生效。
- 完整防护（普通朋友拷文件白嫖被堵死）= 客户端 + 服务端都更新。仅服务端时，老客户端的上传因无章被 fail-open 放行，防护未完全生效。
