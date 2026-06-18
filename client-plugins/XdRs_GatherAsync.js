//=============================================================================
// XdRs_GatherAsync.js  v1.0
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 非阻塞采集系统：<Resource> 事件改为可中断、不锁主线的 channeling
 * @author xsg-online
 *
 * @param channelFrames
 * @text 采集进度条帧数
 * @type number
 * @min 1
 * @default 60
 *
 * @param cancelOnMove
 * @text 玩家移动是否取消
 * @type boolean
 * @default true
 *
 * @param cancelOnEsc
 * @text 取消键(Esc)是否取消
 * @type boolean
 * @default true
 *
 * @param cancelOnMenu
 * @text 玩家打开菜单时取消
 * @type boolean
 * @default false
 *
 * @param progressBarColor
 * @text 进度条颜色
 * @type string
 * @default #ffd13a
 *
 * @param progressBarBackColor
 * @text 进度条底色
 * @type string
 * @default rgba(0,0,0,0.65)
 *
 * @param progressBarWidth
 * @text 进度条宽度(px)
 * @type number
 * @default 96
 *
 * @param progressBarHeight
 * @text 进度条高度(px)
 * @type number
 * @default 8
 *
 * @param progressBarYOffset
 * @text 进度条相对事件的Y偏移
 * @type number
 * @default -56
 *
 * @param resourceTagRegex
 * @text 资源事件 note 匹配正则
 * @type string
 * @default <Resource>
 *
 * @param skipMessages
 * @text 跳过 ShowText 消息(避免阻塞)
 * @type boolean
 * @default true
 *
 * @param redirectMessageToArder
 * @text 把 ShowText 内容转发到 Arder 聊天气泡
 * @type boolean
 * @default true
 *
 * @param successSe
 * @text 采集成功 SE
 * @type string
 * @default Heal3
 *
 * @param failSe
 * @text 采集失败 SE
 * @type string
 * @default Buzzer1
 *
 * @param cancelSe
 * @text 采集取消 SE
 * @type string
 * @default Cancel2
 *
 * @param startSe
 * @text 采集开始 SE
 * @type string
 * @default Cursor1
 *
 * @param tintDuringChannel
 * @text 采集时是否套色调
 * @type boolean
 * @default true
 *
 * @param balloonDuringChannel
 * @text 采集时玩家头顶气泡(0=关闭)
 * @type number
 * @default 11
 *
 * @help
 * ============================================================================
 * 概述
 * ============================================================================
 * 把 note 含 <Resource> 的事件改成"非阻塞采集"。玩家在 channelFrames 帧后
 * 才会触发原事件页里的奖励/扣体力/置位开关等所有副作用，期间可移动取消、
 * 可打开背包/任务/菜单。采集中再走到资源点不会重复触发。
 *
 * 工作机制
 * ----------------------------------------------------------------------------
 *  1. Game_Event.start 被拦截：若 note 命中 <Resource> 且事件页 conditions
 *     满足，启动 GatherChannel，不交给 Game_Interpreter。
 *  2. Channel 期间显示头顶进度条；玩家移动/Esc/打开菜单等条件触发取消。
 *  3. Channel 自然结束后进入 Executing：以"非阻塞虚拟解释器"执行事件页 list:
 *      - 122/121/123/125/126/315  -> 同步执行（数值/物品/经验/开关）
 *      - 111/411/412/0/657         -> 控制流（按 indent 跳过未命中分支）
 *      - 212/213/223/231/235       -> 异步播放（不阻塞）
 *      - 230                       -> 转 wait 队列，仍不阻塞玩家
 *      - 357                       -> 调 PluginManager.callCommand
 *      - 101/401/402/404/408       -> 跳过(可选转 Arder.SendMessage)
 *  4. 旧版 wait 标志 (212[2]=true / 223[2]=true) 一律忽略。
 *
 * 兼容性
 * ----------------------------------------------------------------------------
 *  - 没命中 <Resource> 的事件 100% 走原生路径
 *  - 不写存档（channel 结束后才有副作用）；切场景/标题强制取消
 *  - 不依赖 XdRs_Online_*，但若加载了 Arder Core 会自动转聊天气泡
 *
 * 已知限制
 * ----------------------------------------------------------------------------
 *  - 仅识别事件页第一页且条件满足的情况；如果 conditions 是 selfSwitch 翻页
 *    后的空页，自动跳过(让原生事件正常处理)
 *  - 嵌套深度大于 9 的分支按现有 list 顺序解析
 *  - 不支持 122 source=4 (脚本) — 原 RMMZ 也极少用
 */
(() => {
  'use strict';
  const PLUGIN = 'XdRs_GatherAsync';
  const params = PluginManager.parameters(PLUGIN);
  const CFG = {
    channelFrames: Math.max(1, Number(params.channelFrames || 60)),
    cancelOnMove: params.cancelOnMove !== 'false',
    cancelOnEsc:  params.cancelOnEsc  !== 'false',
    cancelOnMenu: params.cancelOnMenu === 'true',
    barColor: String(params.progressBarColor || '#ffd13a'),
    barBack:  String(params.progressBarBackColor || 'rgba(0,0,0,0.65)'),
    barW:     Math.max(20, Number(params.progressBarWidth || 96)),
    barH:     Math.max(4,  Number(params.progressBarHeight || 8)),
    barYOff:  Number(params.progressBarYOffset || -56),
    tagRe:    new RegExp(String(params.resourceTagRegex || '<Resource>'), 'i'),
    skipMessages: params.skipMessages !== 'false',
    redirectMsg: params.redirectMessageToArder !== 'false',
    successSe: String(params.successSe || 'Heal3'),
    failSe:    String(params.failSe || 'Buzzer1'),
    cancelSe:  String(params.cancelSe || 'Cancel2'),
    startSe:   String(params.startSe || 'Cursor1'),
    tintDuringChannel: params.tintDuringChannel !== 'false',
    balloonId: Number(params.balloonDuringChannel || 0),
  };

  // ------------------------------------------------------------------
  // Util
  // ------------------------------------------------------------------
  const Util = {
    isResourceEvent(event) {
      if (!event) return false;
      const data = typeof event.event === 'function' ? event.event() : null;
      return !!(data && data.note && CFG.tagRe.test(data.note));
    },
    isPageEmpty(page) {
      if (!page || !page.list) return true;
      // 仅含一个 code:0 = 空页
      return page.list.length <= 1;
    },
    playSe(name, vol = 70) {
      if (!name) return;
      AudioManager.playSe({ name, volume: vol, pitch: 100, pan: 0 });
    },
    sendArderMessage(text) {
      if (!CFG.redirectMsg || !text) return;
      try {
        if (typeof PluginManager.callCommand === 'function') {
          PluginManager.callCommand(null, 'XdRs_Arder_Core', 'SendMessage', { text });
        }
      } catch (_) { /* swallow */ }
    },
    operateValue(operation, operandType, operand) {
      // 复刻 Game_Interpreter.operateValue
      const value = operandType === 0 ? operand : $gameVariables.value(operand);
      return operation === 0 ? value : -value;
    },
  };

  // ------------------------------------------------------------------
  // VirtualInterpreter — 非阻塞模拟执行 page.list
  // ------------------------------------------------------------------
  class VirtualInterpreter {
    constructor(event, list) {
      this.event = event;
      this.list = list;
      this.index = 0;
      this.branchSkipUntilIndent = -1; // 跳过 indent > N 的命令
      this.elseBranchActive = false;
    }
    /** 同步执行所有命令；耗时操作改异步派发 */
    run() {
      while (this.index < this.list.length) {
        const cmd = this.list[this.index++];
        if (!cmd) continue;
        // 分支跳过逻辑：
        // 当 branchSkipUntilIndent != -1，意味着我们在跳过 indent > branchSkipUntilIndent 的命令
        if (this.branchSkipUntilIndent >= 0) {
          if (cmd.indent > this.branchSkipUntilIndent) {
            continue;
          }
          // 回到目标 indent 层，检查是否是 411 (Else) 或 412 (BranchEnd)
          if (cmd.indent === this.branchSkipUntilIndent) {
            if (cmd.code === 411) {
              // Else 分支：当前跳过状态决定是否进入
              if (this.elseBranchActive) {
                // 之前 if 没命中，进 else
                this.branchSkipUntilIndent = -1;
                this.elseBranchActive = false;
              }
              continue;
            }
            if (cmd.code === 412) {
              this.branchSkipUntilIndent = -1;
              this.elseBranchActive = false;
              continue;
            }
          }
          continue;
        }
        try {
          this.execute(cmd);
        } catch (e) {
          console.warn('[GatherAsync] cmd execute failed', cmd, e);
        }
      }
    }
    execute(cmd) {
      const c = cmd.code;
      const p = cmd.parameters;
      switch (c) {
        case 0:    return; // End
        case 101:  return this.cmd_showText(p, cmd.indent);
        case 401:  return; // 子文本，已被 101 消化
        case 102:  return; // ShowChoices — 跳过(无人交互), 跳过到 404
        case 402:
        case 403:
        case 404:
        case 408:  return; // Choice/Cancel/End/CommentMore — 跳过
        case 111:  return this.cmd_conditionalBranch(p, cmd.indent);
        case 121:  return this.cmd_controlSwitch(p);
        case 122:  return this.cmd_controlVariable(p);
        case 123:  return this.cmd_selfSwitch(p);
        case 125:  return this.cmd_changeGold(p);
        case 126:  return this.cmd_gainItem(p);
        case 127:  return this.cmd_gainWeapon(p);
        case 128:  return this.cmd_gainArmor(p);
        case 212:  return this.cmd_showAnimation(p);
        case 213:  return this.cmd_balloon(p);
        case 223:  return this.cmd_tintScreen(p);
        case 224:  return this.cmd_flashScreen(p);
        case 225:  return this.cmd_shakeScreen(p);
        case 230:  return; // wait — 静默跳过(不阻塞)
        case 231:  return this.cmd_showPicture(p);
        case 232:  return this.cmd_movePicture(p);
        case 235:  return this.cmd_erasePicture(p);
        case 236:  return this.cmd_setWeather(p);
        case 241:  return this.cmd_playBGM(p);
        case 245:  return this.cmd_playBGS(p);
        case 249:  return this.cmd_playME(p);
        case 250:  return this.cmd_playSE(p);
        case 314:  return this.cmd_recoverAll(p);
        case 315:  return this.cmd_changeExp(p);
        case 316:  return this.cmd_changeLevel(p);
        case 357:  return this.cmd_pluginCommand(p);
        case 657:  return; // ScriptLine annotation, ignore
        case 411:  return; // Else, only relevant in skipping mode
        case 412:  return; // Branch End
        case 108:
        case 408:  return; // Comment / ChoiceLine
        default:
          // 未识别命令：默认跳过, debug 打印
          if (this._debug) console.log('[GatherAsync] unhandled code', c, p);
          return;
      }
    }
    cmd_showText(p, indent) {
      // p: ["", faceIndex, background, position, name]
      // 后续 401 行是文本
      const lines = [];
      while (this.index < this.list.length) {
        const next = this.list[this.index];
        if (!next || next.code !== 401 || next.indent !== indent) break;
        lines.push(next.parameters[0] || '');
        this.index++;
      }
      const text = lines.join('\n').trim();
      if (text && CFG.skipMessages) {
        Util.sendArderMessage(text);
      }
    }
    cmd_conditionalBranch(p, indent) {
      // p: [type, ...args]
      const ok = this.evalCondition(p);
      if (ok) {
        this.elseBranchActive = false;
        return; // 命中：正常往下执行
      }
      // 不命中：跳过到同 indent 的 411(Else) 或 412(BranchEnd)
      this.branchSkipUntilIndent = indent;
      this.elseBranchActive = true;
    }
    evalCondition(p) {
      const type = p[0];
      switch (type) {
        case 0: { // Switch
          const id = p[1], expected = p[2]; // 0=ON, 1=OFF
          const v = $gameSwitches.value(id);
          return expected === 0 ? !!v : !v;
        }
        case 1: { // Variable
          const varId = p[1];
          const operandSrc = p[2]; // 0=const, 1=variable
          const value = p[3];
          const op = p[4]; // 0:==, 1:>=, 2:<=, 3:>, 4:<, 5:!=
          const vV = $gameVariables.value(varId);
          const target = operandSrc === 0 ? value : $gameVariables.value(value);
          switch (op) {
            case 0: return vV === target;
            case 1: return vV >= target;
            case 2: return vV <= target;
            case 3: return vV >  target;
            case 4: return vV <  target;
            case 5: return vV !== target;
          }
          return false;
        }
        case 2: { // Self Switch
          const ch = p[1];
          const expected = p[2];
          if (!this.event) return false;
          const key = [$gameMap.mapId(), this.event.eventId(), ch];
          const v = $gameSelfSwitches.value(key);
          return expected === 0 ? !!v : !v;
        }
        case 3: { // Timer
          if (!$gameTimer.isWorking()) return false;
          const sec = p[1];
          if (p[2] === 0) return $gameTimer.seconds() >= sec;
          else            return $gameTimer.seconds() <= sec;
        }
        case 4: { // Actor
          const actor = $gameActors.actor(p[1]);
          if (!actor) return false;
          switch (p[2]) {
            case 0: return $gameParty.members().includes(actor);
            case 1: return actor.name() === p[3];
            case 2: return actor.isClass($dataClasses[p[3]]);
            case 3: return actor.hasSkill(p[3]);
            case 4: return actor.isEquipped($dataWeapons[p[3]]);
            case 5: return actor.isEquipped($dataArmors[p[3]]);
            case 6: return actor.isStateAffected(p[3]);
          }
          return false;
        }
        case 6: { // Character
          const id = p[1], dir = p[2];
          let ch = null;
          if (id === -1) ch = $gamePlayer;
          else if (id === 0) ch = this.event;
          else ch = $gameMap.event(id);
          return ch && ch.direction() === dir;
        }
        case 8: { // Item
          return $gameParty.hasItem($dataItems[p[1]]);
        }
        case 9: { // Weapon
          return $gameParty.hasItem($dataWeapons[p[1]], p[2]);
        }
        case 10: { // Armor
          return $gameParty.hasItem($dataArmors[p[1]], p[2]);
        }
        case 11: { // Button
          return Input.isPressed(p[1]);
        }
        case 12: { // Script
          try { return !!eval(p[1]); } catch (_) { return false; }
        }
        case 13: { // Vehicle
          return $gamePlayer.vehicle() === $gameMap.vehicle(p[1]);
        }
      }
      return false;
    }
    cmd_controlSwitch(p) {
      const [s, e, val] = p;
      for (let i = s; i <= e; i++) $gameSwitches.setValue(i, val === 0);
    }
    cmd_controlVariable(p) {
      // [varStart, varEnd, op, source, ...rest]
      const [vs, ve, op, src] = p;
      let value = 0;
      switch (src) {
        case 0: value = p[4]; break;
        case 1: value = $gameVariables.value(p[4]); break;
        case 2: { // random
          const min = p[4], max = p[5];
          value = min + Math.randomInt(max - min + 1);
          break;
        }
        case 3: { // game data
          value = this.gameDataOperand(p[4], p[5], p[6]);
          break;
        }
        case 4: { // script
          try { value = eval(p[4]); } catch (_) { value = 0; }
          break;
        }
      }
      for (let i = vs; i <= ve; i++) {
        const cur = $gameVariables.value(i);
        let next = cur;
        switch (op) {
          case 0: next = value; break;
          case 1: next = cur + value; break;
          case 2: next = cur - value; break;
          case 3: next = cur * value; break;
          case 4: next = Math.floor(cur / (value || 1)); break;
          case 5: next = cur % (value || 1); break;
        }
        $gameVariables.setValue(i, next);
      }
    }
    gameDataOperand(type, p1, p2) {
      // 简化版，覆盖常见用法
      switch (type) {
        case 0: return $gameParty.numItems($dataItems[p1]);
        case 1: return $gameParty.numItems($dataWeapons[p1]);
        case 2: return $gameParty.numItems($dataArmors[p1]);
        case 3: { // actor
          const a = $gameActors.actor(p1);
          if (!a) return 0;
          switch (p2) {
            case 0: return a.level;
            case 1: return a.currentExp();
            case 2: return a.hp;
            case 3: return a.mp;
            default:
              if (p2 >= 4 && p2 <= 11) return a.param(p2 - 4);
              return 0;
          }
        }
        case 4: { // enemy
          const e = $gameTroop.members()[p1];
          if (!e) return 0;
          switch (p2) {
            case 0: return e.hp;
            case 1: return e.mp;
            default: return e.param(p2 - 2);
          }
        }
        case 5: { // character
          let ch = p1 === -1 ? $gamePlayer : (p1 === 0 ? this.event : $gameMap.event(p1));
          if (!ch) return 0;
          switch (p2) {
            case 0: return ch.x;
            case 1: return ch.y;
            case 2: return ch.direction();
            case 3: return ch.screenX();
            case 4: return ch.screenY();
          }
          return 0;
        }
        case 6: return $gameParty.steps();
        case 7: return $gameParty.gold();
        case 8: return $gameTimer.seconds();
        case 9: return $gameSystem.saveCount();
        case 10: return $gameSystem.battleCount();
        case 11: return $gameSystem.winCount();
        case 12: return $gameSystem.escapeCount();
      }
      return 0;
    }
    cmd_selfSwitch(p) {
      if (!this.event) return;
      const key = [$gameMap.mapId(), this.event.eventId(), p[0]];
      $gameSelfSwitches.setValue(key, p[1] === 0);
    }
    cmd_changeGold(p) {
      const value = Util.operateValue(p[0], p[1], p[2]);
      $gameParty.gainGold(value);
    }
    cmd_gainItem(p) {
      const item = $dataItems[p[0]];
      if (!item) return;
      const value = Util.operateValue(p[1], p[2], p[3]);
      $gameParty.gainItem(item, value);
    }
    cmd_gainWeapon(p) {
      const item = $dataWeapons[p[0]];
      if (!item) return;
      const value = Util.operateValue(p[1], p[2], p[3]);
      $gameParty.gainItem(item, value, !!p[4]);
    }
    cmd_gainArmor(p) {
      const item = $dataArmors[p[0]];
      if (!item) return;
      const value = Util.operateValue(p[1], p[2], p[3]);
      $gameParty.gainItem(item, value, !!p[4]);
    }
    cmd_showAnimation(p) {
      // p: [characterId, animationId, waitFlag]
      const target = this.resolveCharacter(p[0]);
      if (target && p[1]) $gameTemp.requestAnimation([target], p[1]);
      // wait flag 忽略
    }
    cmd_balloon(p) {
      const target = this.resolveCharacter(p[0]);
      if (target) $gameTemp.requestBalloon(target, p[1]);
    }
    cmd_tintScreen(p) {
      // [tone, duration, waitFlag]
      $gameScreen.startTint(p[0], p[1] || 60);
    }
    cmd_flashScreen(p) {
      $gameScreen.startFlash(p[0], p[1] || 30);
    }
    cmd_shakeScreen(p) {
      $gameScreen.startShake(p[0], p[1], p[2] || 30);
    }
    cmd_showPicture(p) {
      // [id, name, origin, x ,y, sx, sy, opacity, blendMode]
      // 简化坐标解析
      const x = (p[3] === 0) ? p[4] : $gameVariables.value(p[4]);
      const y = (p[3] === 0) ? p[5] : $gameVariables.value(p[5]);
      $gameScreen.showPicture(p[0], p[1], p[2], x, y, p[6], p[7], p[8], p[9]);
    }
    cmd_movePicture(p) {
      const x = (p[3] === 0) ? p[4] : $gameVariables.value(p[4]);
      const y = (p[3] === 0) ? p[5] : $gameVariables.value(p[5]);
      $gameScreen.movePicture(p[0], p[2], x, y, p[6], p[7], p[8], p[9], p[10] || 30, p[11] || 0);
    }
    cmd_erasePicture(p) {
      $gameScreen.erasePicture(p[0]);
    }
    cmd_setWeather(p) {
      $gameScreen.changeWeather(p[0], p[1], p[2] || 0);
    }
    cmd_playBGM(p) {
      AudioManager.playBgm(p[0]);
    }
    cmd_playBGS(p) {
      AudioManager.playBgs(p[0]);
    }
    cmd_playME(p) {
      AudioManager.playMe(p[0]);
    }
    cmd_playSE(p) {
      AudioManager.playSe(p[0]);
    }
    cmd_recoverAll(p) {
      const id = p[0];
      $gameParty.members().forEach(a => {
        if (id === 0 || a.actorId() === id) a.recoverAll();
      });
    }
    cmd_changeExp(p) {
      const value = Util.operateValue(p[2], p[3], p[4]);
      this.iterateActorEx(p[0], p[1], a => a.changeExp(a.currentExp() + value, p[5]));
    }
    cmd_changeLevel(p) {
      const value = Util.operateValue(p[2], p[3], p[4]);
      this.iterateActorEx(p[0], p[1], a => a.changeLevel(a.level + value, p[5]));
    }
    iterateActorEx(param1, param2, fn) {
      // 复刻原版 Game_Interpreter.iterateActorEx：
      //   param1 = 0 -> 常量, 用 param2 作为 actorId
      //   param1 = 1 -> 变量, 用 $gameVariables.value(param2) 作为 actorId
      //   actorId = 0 表示"全队伍"，否则只对指定 actor 执行
      const id = param1 === 0 ? param2 : $gameVariables.value(param2);
      if (id === 0) {
        $gameParty.members().forEach(fn);
      } else {
        const actor = $gameActors.actor(id);
        if (actor) fn(actor);
      }
    }
    cmd_pluginCommand(p) {
      // p: [pluginName, commandName, label, args]
      try {
        if (typeof PluginManager.callCommand === 'function') {
          PluginManager.callCommand(null, p[0], p[1], p[3] || {});
        }
      } catch (e) {
        console.warn('[GatherAsync] plugin command failed', p, e);
      }
    }
    resolveCharacter(id) {
      if (id < 0) return $gamePlayer;
      if (id === 0) return this.event;
      return $gameMap.event(id);
    }
  }

  // ------------------------------------------------------------------
  // GatherUI — 头顶进度条 sprite
  // ------------------------------------------------------------------
  class Sprite_GatherProgress extends Sprite {
    constructor(channel) {
      super(new Bitmap(CFG.barW, CFG.barH));
      this.anchor.x = 0.5;
      this.anchor.y = 1.0;
      this._channel = channel;
      this._fadeAlpha = 1.0;
      this._fading = false;
      this.refresh(0);
    }
    update() {
      super.update();
      const ch = this._channel;
      if (!ch) return;
      // 跟随事件
      if (ch.event) {
        this.x = ch.event.screenX();
        this.y = ch.event.screenY() + CFG.barYOff;
      }
      if (this._fading) {
        this._fadeAlpha = Math.max(0, this._fadeAlpha - 0.06);
        this.opacity = Math.floor(255 * this._fadeAlpha);
        if (this._fadeAlpha <= 0 && this.parent) {
          this.parent.removeChild(this);
        }
      } else {
        this.refresh(ch.progress(), ch.state);
      }
    }
    refresh(p, state) {
      const b = this.bitmap;
      const w = CFG.barW, h = CFG.barH;
      b.clear();
      b.fillRect(0, 0, w, h, CFG.barBack);
      let color = CFG.barColor;
      if (state === 'cancelled') color = '#e63946';
      else if (state === 'done') color = '#7bd87b';
      const fillW = Math.max(0, (w - 2) * p);
      b.fillRect(1, 1, fillW, h - 2, color);
    }
    fadeOut() { this._fading = true; }
  }

  // ------------------------------------------------------------------
  // GatherChannel
  // ------------------------------------------------------------------
  class GatherChannel {
    constructor(event) {
      this.event = event;
      this.elapsed = 0;
      this.total = CFG.channelFrames;
      this.startX = $gamePlayer._x;
      this.startY = $gamePlayer._y;
      this.startMapId = $gameMap.mapId();
      this.state = 'channeling';   // channeling | done | cancelled
      this.sprite = null;
    }
    start() {
      if (CFG.tintDuringChannel) {
        $gameScreen.startTint([-34, -34, -34, 0], 15);
      }
      if (CFG.balloonId > 0) {
        $gameTemp.requestBalloon($gamePlayer, CFG.balloonId);
      }
      Util.playSe(CFG.startSe, 60);
      this.attachSprite();
      this.event.unlock(); // 取消朝向锁
    }
    attachSprite() {
      const scene = SceneManager._scene;
      if (!scene || !scene._spriteset) return;
      const tilemap = scene._spriteset._tilemap;
      if (!tilemap) return;
      this.sprite = new Sprite_GatherProgress(this);
      tilemap.addChild(this.sprite);
    }
    update() {
      if (this.state !== 'channeling') return;
      // 地图切换 -> 取消
      if ($gameMap.mapId() !== this.startMapId) return this.cancel('map-change');
      // 玩家移动 -> 取消
      if (CFG.cancelOnMove) {
        if ($gamePlayer._x !== this.startX || $gamePlayer._y !== this.startY) {
          return this.cancel('moved');
        }
        // 方向键按下也判定为取消（即使还没换格）
        if (this.elapsed > 5 && (Input.isPressed('up') || Input.isPressed('down') ||
            Input.isPressed('left') || Input.isPressed('right'))) {
          return this.cancel('input');
        }
      }
      // Esc / 取消键
      if (CFG.cancelOnEsc && Input.isTriggered('cancel')) {
        return this.cancel('user');
      }
      // 菜单
      if (CFG.cancelOnMenu && SceneManager._scene && !(SceneManager._scene instanceof Scene_Map)) {
        return this.cancel('menu');
      }
      this.elapsed++;
      if (this.elapsed >= this.total) this.complete();
    }
    complete() {
      this.state = 'done';
      // 联机：服务端管理的资源由 XdRs_Online_Gather 接管(走认领+服务端发货)，跳过本地结算
      const XG = window.XdRsOnline;
      const handled = !!(XG && XG.Gather && typeof XG.Gather.onResourceComplete === 'function'
        && XG.Gather.onResourceComplete(this.event));
      if (!handled) {
        this.executeEventPage();
      }
      if (CFG.tintDuringChannel) {
        $gameScreen.startTint([0, 0, 0, 0], 20);
      }
      if (this.sprite) this.sprite.fadeOut();
      // 成功/失败 SE 由模拟器内部根据是否得物可能不准；这里统一播 success
      Util.playSe(CFG.successSe, 70);
    }
    cancel(reason) {
      if (this.state !== 'channeling') return;
      this.state = 'cancelled';
      this._cancelReason = reason;
      if (CFG.tintDuringChannel) {
        $gameScreen.startTint([0, 0, 0, 0], 15);
      }
      if (this.sprite) this.sprite.fadeOut();
      Util.playSe(CFG.cancelSe, 60);
    }
    progress() {
      return Math.min(1, this.elapsed / this.total);
    }
    /** 解释器：找到匹配的事件页并模拟执行 */
    executeEventPage() {
      const data = typeof this.event.event === 'function' ? this.event.event() : null;
      if (!data) return;
      // 找当前满足条件的页
      const page = this.findActivePage(data);
      if (!page || Util.isPageEmpty(page)) return;
      const vi = new VirtualInterpreter(this.event, page.list);
      vi.run();
      // 部分事件靠 selfSwitch A 翻页消失，模拟器已执行；保险：refresh
      if (typeof this.event.refresh === 'function') this.event.refresh();
      if ($gameMap && typeof $gameMap.requestRefresh === 'function') $gameMap.requestRefresh();
    }
    findActivePage(data) {
      // 复刻 Game_Event.findProperPageIndex 的简化版
      for (let i = data.pages.length - 1; i >= 0; i--) {
        const page = data.pages[i];
        if (this.meetsConditions(page)) return page;
      }
      return null;
    }
    meetsConditions(page) {
      const c = page.conditions;
      if (c.switch1Valid && !$gameSwitches.value(c.switch1Id)) return false;
      if (c.switch2Valid && !$gameSwitches.value(c.switch2Id)) return false;
      if (c.variableValid && $gameVariables.value(c.variableId) < c.variableValue) return false;
      if (c.selfSwitchValid) {
        const key = [$gameMap.mapId(), this.event.eventId(), c.selfSwitchCh];
        if (!$gameSelfSwitches.value(key)) return false;
      }
      if (c.itemValid) {
        const item = $dataItems[c.itemId];
        if (!$gameParty.hasItem(item)) return false;
      }
      if (c.actorValid) {
        const actor = $gameActors.actor(c.actorId);
        if (!actor || !$gameParty.members().includes(actor)) return false;
      }
      return true;
    }
  }

  // ------------------------------------------------------------------
  // Manager
  // ------------------------------------------------------------------
  const GatherManager = window.GatherManager = {
    active: null,
    cooldownEvents: new Map(), // eventId -> framesRemaining，避免连触发
    update() {
      // 冷却递减
      if (this.cooldownEvents.size > 0) {
        for (const [k, v] of this.cooldownEvents) {
          if (v <= 1) this.cooldownEvents.delete(k);
          else this.cooldownEvents.set(k, v - 1);
        }
      }
      if (!this.active) return;
      this.active.update();
      if (this.active.state !== 'channeling') {
        // 给该事件加 30 帧冷却避免马上又触发
        this.cooldownEvents.set(this.active.event.eventId(), 30);
        this.active = null;
      }
    },
    isBusy() { return !!this.active && this.active.state === 'channeling'; },
    canStart(event) {
      if (this.isBusy()) return false;
      if (this.cooldownEvents.has(event.eventId())) return false;
      return true;
    },
    start(event) {
      if (!this.canStart(event)) return false;
      this.active = new GatherChannel(event);
      // 必须先校验事件页可执行
      const data = typeof event.event === 'function' ? event.event() : null;
      if (!data) {
        this.active = null;
        return false;
      }
      const page = this.active.findActivePage(data);
      if (!page || Util.isPageEmpty(page)) {
        this.active = null;
        return false;
      }
      this.active.start();
      return true;
    },
    forceCancel(reason) {
      if (this.active && this.active.state === 'channeling') {
        this.active.cancel(reason || 'force');
      }
      this.active = null;
    },
  };

  // ------------------------------------------------------------------
  // Hooks
  // ------------------------------------------------------------------
  const _Game_Event_start = Game_Event.prototype.start;
  Game_Event.prototype.start = function () {
    if (Util.isResourceEvent(this) && !$gameMap.isEventRunning()) {
      const ok = GatherManager.start(this);
      if (ok) {
        // 阻止进入原生 interpreter
        this._starting = false;
        return;
      }
      // 资源事件但暂时无法启动（正在采集/冷却中）：完全静音, 不走原生事件锁主线
      this._starting = false;
      return;
    }
    _Game_Event_start.call(this);
  };

  const _Scene_Map_update = Scene_Map.prototype.update;
  Scene_Map.prototype.update = function (active) {
    _Scene_Map_update.call(this, active);
    GatherManager.update();
  };

  const _Scene_Map_terminate = Scene_Map.prototype.terminate;
  Scene_Map.prototype.terminate = function () {
    GatherManager.forceCancel('scene-change');
    _Scene_Map_terminate.call(this);
  };

  // 切场景前清干净（Scene_Title 会重启数据，不能让残留 sprite 引用旧 event）
  const _SceneManager_goto = SceneManager.goto;
  SceneManager.goto = function (sceneClass) {
    if (window.GatherManager) GatherManager.forceCancel('scene-goto');
    _SceneManager_goto.call(this, sceneClass);
  };

  // 调试钩子
  window.XdRsGatherAsync = {
    cfg: CFG,
    Manager: GatherManager,
    Channel: GatherChannel,
    VirtualInterpreter: VirtualInterpreter,
  };

  console.log('[GatherAsync] loaded; channelFrames=' + CFG.channelFrames);
})();
