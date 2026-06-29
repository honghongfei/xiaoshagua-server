// 客户端插件 XdRs_TaskAtomicDeduct 行为测试。
// 用最小 RMMZ 解释器桩（command111/126/357/skipBranch/terminate 等）真实跑「台阶式」交任务事件，
// 验证：材料够 → 扣除并完成；材料不够 → 中途扣的料被回滚，玩家不被误扣，任务未完成。
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_PATH = path.resolve(process.cwd(), '../../xiaoshagua/js/plugins/XdRs_TaskAtomicDeduct.js');

// --- 最小 RMMZ 运行时桩 ---
class GameParty {
  _items: Record<number, number> = {};
  completed: number[] = [];
  numItems(obj: { id: number }): number { return this._items[obj.id] || 0; }
  gainItem(obj: { id: number }, n: number): void {
    this._items[obj.id] = Math.max(0, (this._items[obj.id] || 0) + n); // 原生 RMMZ 钳到 0
  }
  completeTask(id: number): void { this.completed.push(id); }
}

class GameInterpreter {
  _depth: number;
  _list: any[] | null = null;
  _index = 0;
  _indent = 0;
  _branch: Record<number, unknown> = {};
  _childInterpreter: GameInterpreter | null = null;
  constructor(depth = 0) { this._depth = depth; }
  clear(): void { this._list = null; this._index = 0; this._branch = {}; this._indent = 0; this._childInterpreter = null; }
  setup(list: any[], eventId?: number): void { this.clear(); this._list = list; (this as any)._eventId = eventId; }
  setupChild(list: any[], eventId?: number): void {
    this._childInterpreter = new GameInterpreter(this._depth + 1);
    this._childInterpreter.setup(list, eventId);
  }
  currentCommand(): any { return this._list ? this._list[this._index] : null; }
  executeCommand(): boolean {
    const c = this.currentCommand();
    if (c) {
      this._indent = c.indent;
      const m = 'command' + c.code;
      if (typeof (this as any)[m] === 'function') {
        if (!(this as any)[m](c.parameters)) return false;
      }
      this._index++;
    } else {
      this.terminate();
    }
    return true;
  }
  terminate(): void { this._list = null; }
  skipBranch(): void {
    while (this._list && this._list[this._index + 1].indent > this._indent) this._index++;
  }
  operateValue(operation: number, _operandType: number, operand: number): number {
    return operation === 0 ? operand : -operand;
  }
  command111(params: any[]): boolean {
    let result = false;
    if (params[0] === 8) result = (globalThis as any).$gameParty.numItems((globalThis as any).$dataItems[params[1]]) >= 1;
    this._branch[this._indent] = result;
    if (result === false) this.skipBranch();
    return true;
  }
  command411(): boolean { if (this._branch[this._indent] !== false) this.skipBranch(); return true; }
  command412(): boolean { return true; }
  command126(params: any[]): boolean {
    const v = this.operateValue(params[1], params[2], params[3]);
    (globalThis as any).$gameParty.gainItem((globalThis as any).$dataItems[params[0]], v);
    return true;
  }
  command127(params: any[]): boolean { return true; }
  command128(params: any[]): boolean { return true; }
  command357(params: any[]): boolean {
    if (params[0] === 'XdRs_Arder_Core' && params[1] === 'CompleteTask') {
      (globalThis as any).$gameParty.completeTask(Number(params[3].id));
    }
    return true;
  }
  run(): void { let guard = 0; while (this._list && guard++ < 100000) this.executeCommand(); }
}

function installClasses(): void {
  const g = globalThis as any;
  g.window = g;
  g.Game_Interpreter = GameInterpreter;
  g.Game_Party = GameParty;
  g.$dataItems = [null, ...Array.from({ length: 1000 }, (_v, i) => ({ id: i + 1 }))];
  g.$dataWeapons = [null];
  g.$dataArmors = [null];
}

function resetState(): void {
  const g = globalThis as any;
  g.$gameTemp = { messages: [] as string[], addWorldMessage(m: string) { this.messages.push(m); } };
  g.$gameParty = new GameParty();
}

function loadPlugin(): void {
  const src = fs.readFileSync(PLUGIN_PATH, 'utf8');
  // 间接 eval：在全局作用域执行，使插件里裸引用的 Game_Interpreter 等解析到 globalThis
  (0, eval)(src);
}

// 台阶式「交 2 个物品#13」事件页（镜像真实地图事件结构）
function staircaseTurnIn(itemId: number, taskId: number) {
  return [
    { code: 111, indent: 0, parameters: [8, itemId] },
    { code: 126, indent: 1, parameters: [itemId, 1, 0, 1] }, // 扣 1
    { code: 111, indent: 1, parameters: [8, itemId] },
    { code: 126, indent: 2, parameters: [itemId, 1, 0, 1] }, // 扣 1
    { code: 357, indent: 2, parameters: ['XdRs_Arder_Core', 'CompleteTask', '完成任务', { id: String(taskId) }] },
    { code: 411, indent: 1, parameters: [] },
    { code: 412, indent: 1, parameters: [] },
    { code: 411, indent: 0, parameters: [] },
    { code: 412, indent: 0, parameters: [] },
    { code: 0, indent: 0, parameters: [] },
  ];
}

describe('XdRs_TaskAtomicDeduct (交任务防误扣)', () => {
  beforeAll(() => {
    installClasses();
    loadPlugin(); // 仅包裹一次原型，避免重复包裹导致回滚叠加
  });
  beforeEach(() => {
    resetState();
  });

  it('材料充足：正常扣除并完成任务', () => {
    const g = globalThis as any;
    g.$gameParty._items[13] = 2;
    const interp = new g.Game_Interpreter(0);
    interp.setup(staircaseTurnIn(13, 436), 1);
    interp.run();
    expect(g.$gameParty.numItems(g.$dataItems[13])).toBe(0); // 扣掉 2
    expect(g.$gameParty.completed).toEqual([436]);
  });

  it('材料不足：中途扣的料被回滚，不误扣，任务未完成', () => {
    const g = globalThis as any;
    g.$gameParty._items[13] = 1; // 只有 1 个，需要 2 个
    const interp = new g.Game_Interpreter(0);
    interp.setup(staircaseTurnIn(13, 436), 1);
    interp.run();
    expect(g.$gameParty.numItems(g.$dataItems[13])).toBe(1); // 完璧归赵，无误扣
    expect(g.$gameParty.completed).toEqual([]); // 未完成
    expect(g.$gameTemp.messages.some((m: string) => m.includes('退回'))).toBe(true);
  });

  it('非交任务事件（无 CompleteTask）：正常扣料不受影响', () => {
    const g = globalThis as any;
    g.$gameParty._items[13] = 5;
    const interp = new g.Game_Interpreter(0);
    interp.setup([
      { code: 126, indent: 0, parameters: [13, 1, 0, 3] }, // 直接扣 3（如商店/消耗）
      { code: 0, indent: 0, parameters: [] },
    ], 1);
    interp.run();
    expect(g.$gameParty.numItems(g.$dataItems[13])).toBe(2); // 5-3，不回滚
  });
});
