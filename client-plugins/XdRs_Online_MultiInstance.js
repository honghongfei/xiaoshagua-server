//=============================================================================
// XdRs_Online_MultiInstance.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 多开-实例存档隔离 | 多开实例把本地存档重定向到各自目录
 * @author xsg-online
 *
 * @help
 * 配合「多开启动器.bat」使用。启动器以独立 --user-data-dir 启动 Game.exe，
 * 隔离登录态(localStorage)，并传 --xsg-save-dir=<目录> 指定该实例存档根。
 * 本插件读该参数，把本地存档目录指到 <目录>/save/。
 *
 * 主实例(直接双击 Game.exe，无该参数)行为不变，存档仍在 游戏目录/save/。
 *
 * 必须最早加载(放 plugins.js 第一项)，确保在任何存档读写前完成 hook。
 */
(() => {
  'use strict';

  // 从 NW.js 命令行读取自定义参数；兼容 argv(过滤后) 与 fullArgv(全量)
  function readArg(name) {
    try {
      if (typeof nw === 'undefined' || !nw.App) return null;
      const lists = [nw.App.argv || [], nw.App.fullArgv || []];
      const re = new RegExp('^--' + name + '=(.+)$');
      for (const list of lists) {
        for (const a of list) {
          const m = re.exec(String(a));
          if (m) return m[1];
        }
      }
    } catch (e) {
      // 非 NW 环境(浏览器调试)：忽略
    }
    return null;
  }

  const saveDir = readArg('xsg-save-dir');
  if (!saveDir) return; // 主实例：不改任何行为

  try {
    const path = require('path');
    const target = path.join(saveDir, 'save/');
    // 覆盖本地存档目录；其余存档逻辑(迁移/云同步)均经此函数，自动落该目录
    StorageManager.fileDirectoryPath = function () {
      return target;
    };
    const G = window.XdRsOnline;
    if (G && G.Util && typeof G.Util.log === 'function') {
      G.Util.log('info', '[MultiInstance] local save dir -> ' + target);
    } else {
      console.log('[XSG-MultiInstance] local save dir -> ' + target);
    }
  } catch (e) {
    console.error('[XSG-MultiInstance] hook failed:', e);
  }
})();
