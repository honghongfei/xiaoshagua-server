//=============================================================================
// XdRs_Online_SharedState.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-共享状态 | 指定 switch/variable id 走服务器全局同步
 * @author xsg-online
 *
 * @param sharedSwitchIds
 * @text 共享开关 ID 列表
 * @desc 逗号分隔，如 "1,5,12,20"。这些 ID 的 setValue 会同步给所有玩家。
 * @type string
 * @default
 *
 * @param sharedVariableIds
 * @text 共享变量 ID 列表
 * @type string
 * @default
 *
 * @help
 * 拦截 Game_Switches.setValue / Game_Variables.setValue：
 *   - 若 id 在共享列表，则发 state.setSwitch / state.setVar 给服务器，服务器广播
 *     回所有人；本地用 _silentSet 应用避免循环
 *   - 否则按 RMMZ 原生行为本地处理（仍记录到角色个人开关/变量）
 *
 * 进入 Scene_Map 拉取一次 state.snapshot 校准。
 */
(() => {
  'use strict';
  const G = window.XdRsOnline;
  if (!G || !G.Net || !G.Core) {
    console.error('[XSG-Online] SharedState: deps missing');
    return;
  }
  const Util = G.Util;
  const Net = G.Net;
  const Core = G.Core;
  const params = PluginManager.parameters('XdRs_Online_SharedState');
  const sw = parseIds(params.sharedSwitchIds);
  const va = parseIds(params.sharedVariableIds);

  function parseIds(s) {
    const out = new Set();
    String(s || '').split(',').map(x => x.trim()).filter(Boolean).forEach((v) => {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) out.add(n);
    });
    return out;
  }

  const State = (G.SharedState = G.SharedState || {});
  State.sharedSwitches = sw;
  State.sharedVariables = va;
  let suppressBroadcast = false;

  // ---------- Game_Switches ----------
  const _switchesSet = Game_Switches.prototype.setValue;
  Game_Switches.prototype.setValue = function (switchId, value) {
    _switchesSet.call(this, switchId, value);
    if (suppressBroadcast) return;
    if (!Core.isOnline()) return;
    if (!sw.has(switchId)) return;
    Net.request('state.setSwitch', { id: switchId, value: value ? 1 : 0 }, 4000)
      .catch((err) => Util.log('warn', 'state.setSwitch failed:', err && err.message));
  };

  // ---------- Game_Variables ----------
  const _varsSet = Game_Variables.prototype.setValue;
  Game_Variables.prototype.setValue = function (variableId, value) {
    _varsSet.call(this, variableId, value);
    if (suppressBroadcast) return;
    if (!Core.isOnline()) return;
    if (!va.has(variableId)) return;
    Net.request('state.setVar', { id: variableId, value: value | 0 }, 4000)
      .catch((err) => Util.log('warn', 'state.setVar failed:', err && err.message));
  };

  function applyFromServer(applyFn) {
    suppressBroadcast = true;
    try { applyFn(); } finally { suppressBroadcast = false; }
  }

  Net.on('state.switchEvt', (e) => {
    if (!e || !$gameSwitches) return;
    if (!sw.has(e.id)) return;
    applyFromServer(() => $gameSwitches.setValue(e.id, !!e.value));
  });

  Net.on('state.varEvt', (e) => {
    if (!e || !$gameVariables) return;
    if (!va.has(e.id)) return;
    applyFromServer(() => $gameVariables.setValue(e.id, e.value | 0));
  });

  // ---------- Snapshot on map enter ----------
  const _Scene_Map_start = Scene_Map.prototype.start;
  Scene_Map.prototype.start = function () {
    _Scene_Map_start.call(this);
    if (!Core.isOnline()) return;
    Net.request('state.snapshot', {}, 6000).then((snap) => {
      if (!snap) return;
      applyFromServer(() => {
        if ($gameSwitches && snap.switches) {
          for (const s of snap.switches) {
            if (sw.has(s.id)) $gameSwitches.setValue(s.id, !!s.value);
          }
        }
        if ($gameVariables && snap.vars) {
          for (const v of snap.vars) {
            if (va.has(v.id)) $gameVariables.setValue(v.id, v.value | 0);
          }
        }
      });
      Util.log('debug', 'shared state snap applied: sw=' + (snap.switches || []).length + ' var=' + (snap.vars || []).length);
    }).catch((err) => Util.log('warn', 'state snapshot failed:', err && err.message));
  };
})();
