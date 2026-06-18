//=============================================================================
// XdRs_Online_SaveOwner.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-存档归属 | 登录态保存时给存档盖账号归属章, 防普通朋友拷文件白嫖
 * @author xsg-online
 *
 * @help
 * ============================================================================
 * 用途
 * ============================================================================
 * 给存档盖"归属章": 登录联机后保存的存档, 在 contents 顶层写
 *     xsgOwner = { v:1, pid, accountId, at }
 * 配合两道门禁实现"存档锁账号":
 *   - SaveMigrate 上传前校验归属(别人账号的存档不让传, 且不跑 inventory.replace)
 *   - 服务端 save.upload 兜底校验(owner.pid != s.pid 抛 SAVE_FOREIGN)
 *
 * 设计要点
 * ----------------------------------------------------------------------------
 *   - 离线保存不盖章(保证离线读档/玩法不受影响)
 *   - 校验只认 pid(= 服务端 s.pid, 与云档 key 一致); accountId 仅展示
 *   - hook DataManager.makeSaveContents, 覆盖 SaveCloud 自动同步 / 手动 saveGame /
 *     beforeunload 等所有"在内存里现造 contents 再上传"的路径
 *   - SaveMigrate 是从磁盘读老存档上传(不经 makeSaveContents), 由其自身显式盖章/校验
 *
 * 必须在 XdRs_Online_Core 之后、SaveCloud / SaveMigrate 之前加载.
 *
 * 依赖: XdRs_Online_Util, XdRs_Online_Core
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Core) {
    console.error('[XSG-Online] SaveOwner: deps missing (Core)');
    return;
  }
  const Core = G.Core;
  const Util = G.Util;

  function currentPid() {
    const ch = Core.session && Core.session.character;
    return ch && typeof ch.pid === 'number' ? ch.pid : null;
  }
  function currentAccountId() {
    const ch = Core.session && Core.session.character;
    return ch && ch.accountId != null ? ch.accountId : null;
  }

  const SaveOwner = (G.SaveOwner = G.SaveOwner || {});

  // 给 contents 盖归属章; 仅登录态且能拿到 pid 时(离线不盖). 幂等: 覆盖式写当前归属.
  SaveOwner.stamp = function (contents) {
    if (!contents || typeof contents !== 'object') return contents;
    if (!Core.isOnline || !Core.isOnline()) return contents;
    const pid = currentPid();
    if (typeof pid !== 'number') return contents;
    contents.xsgOwner = { v: 1, pid, accountId: currentAccountId(), at: Date.now() };
    return contents;
  };

  // hook makeSaveContents: 覆盖所有"现造 contents 上传"的路径
  if (DataManager && DataManager.makeSaveContents && !DataManager._xsg_saveOwner_patched) {
    const _makeSaveContents = DataManager.makeSaveContents;
    DataManager.makeSaveContents = function () {
      const contents = _makeSaveContents.call(this);
      try {
        SaveOwner.stamp(contents);
      } catch (e) {
        console.warn('[XSG-Online] SaveOwner stamp failed:', e && e.message);
      }
      return contents;
    };
    DataManager._xsg_saveOwner_patched = true;
  }

  if (Util && Util.log) Util.log('info', 'SaveOwner plugin loaded');
})();
