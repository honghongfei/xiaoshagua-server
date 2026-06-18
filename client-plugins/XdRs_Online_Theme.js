//=============================================================================
// XdRs_Online_Theme.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc 联机-UI主题 | 把联机 DOM 面板统一成《小傻瓜》原版橙绿卡通风（纯CSS，不依赖图片）
 * @author xsg-online
 *
 * @help
 * 注入一套全局 CSS（.xsg-* 类），供各联机面板复用，使 DOM 面板与原版游戏
 * 画风一致：橙色外壳 + 绿色内容区 + 金黄标题 + 橙色圆角按钮。
 * 不读取任何图片资源（避开 img/system 的 .png_ 加密图）。
 *
 * 用法：面板容器加 class="xsg-win"，外层遮罩 class="xsg-overlay"，
 * 标题栏 xsg-titlebar / 标题 xsg-title / 内容 xsg-body / 状态条 xsg-statusbar，
 * 按钮 xsg-btn(.is-active) / xsg-btn-primary / xsg-btn-danger / xsg-btn-warn / xsg-btn-close，
 * 输入 xsg-input / xsg-select，列表行 xsg-row，文字色 xsg-muted / xsg-gold / xsg-cyan，
 * 通知卡片 xsg-toast。改本文件的配色即可一处改、全面板生效。
 *
 * 必须在其它 XdRs_Online_* 面板插件之前加载。
 */
(() => {
  'use strict';
  if (typeof document === 'undefined') return;
  if (document.getElementById('xsg-online-theme-style')) return;

  const css = [
    ':root{',
    '  --xsg-shell:linear-gradient(180deg,#f3a23e 0%,#e8852c 100%);',
    '  --xsg-shell-edge:#b85e16;',
    '  --xsg-panel:linear-gradient(180deg,#b6d35a 0%,#a3c247 100%);',
    '  --xsg-panel-edge:#6f9c34;',
    '  --xsg-title:#fff2c2;',
    '  --xsg-ink:#3f3315;',
    '  --xsg-gold:#8a5a12;',
    '  --xsg-accent:#b03a86;',
    '  --xsg-font:"rmmz-mainfont","M+ 1m","Microsoft YaHei",sans-serif;',
    '}',
    '.xsg-overlay{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);}',
    '.xsg-overlay,.xsg-win,.xsg-win *{cursor:default;}',
    '.xsg-win button,.xsg-win select{cursor:pointer;}',
    '.xsg-win input,.xsg-win textarea{cursor:text;}',
    '[id^="xsg-online-"],[id^="xsg-online-"] *{cursor:default;}',
    '[id^="xsg-online-"] button,[id^="xsg-online-"] select{cursor:pointer;}',
    '[id^="xsg-online-"] input,[id^="xsg-online-"] textarea{cursor:text;}',
    '.xsg-win{display:flex;flex-direction:column;background:var(--xsg-shell);color:var(--xsg-ink);font-family:var(--xsg-font);border:3px solid var(--xsg-shell-edge);border-radius:14px;box-shadow:0 0 0 2px rgba(0,0,0,0.30),0 10px 28px rgba(0,0,0,0.5);padding:4px;}',
    '.xsg-titlebar{display:flex;align-items:center;gap:6px;padding:6px 8px 8px;}',
    '.xsg-title{flex:1;font-weight:bold;letter-spacing:2px;font-size:18px;color:var(--xsg-title);text-shadow:0 2px 0 #b5481c,0 0 2px #b5481c;}',
    '.xsg-body{flex:1;overflow-y:auto;padding:10px 12px;line-height:1.7;min-height:220px;margin:0 4px;background:var(--xsg-panel);border:2px solid var(--xsg-panel-edge);border-radius:10px;color:var(--xsg-ink);box-shadow:inset 0 0 0 1px rgba(255,255,255,0.28);}',
    '.xsg-statusbar{padding:5px 12px;margin:4px;}',
    '.xsg-status{font-size:12px;color:var(--xsg-title);text-shadow:0 1px 0 #b5481c;}',
    '.xsg-btn{background:linear-gradient(180deg,#ffc861,#f09a32);color:#5a3410;border:2px solid #c96a1e;border-radius:9px;padding:4px 12px;cursor:pointer;font-family:var(--xsg-font);font-weight:bold;box-shadow:inset 0 1px 0 rgba(255,255,255,0.5);transition:filter 80ms;}',
    '.xsg-btn:hover{filter:brightness(1.08);}',
    '.xsg-btn.is-active{background:linear-gradient(180deg,#ffe07a,#f7b733);border-color:#fff2c2;color:#5a3010;}',
    '.xsg-btn-primary{background:linear-gradient(180deg,#ffd86a,#f5a82e);color:#5a3010;border:2px solid #e0962a;border-radius:9px;padding:4px 12px;cursor:pointer;font-family:var(--xsg-font);font-weight:bold;box-shadow:inset 0 1px 0 rgba(255,255,255,0.5),0 0 6px rgba(255,200,80,0.55);transition:filter 80ms;}',
    '.xsg-btn-primary:hover{filter:brightness(1.08);}',
    '.xsg-btn-danger{background:linear-gradient(180deg,#f0743e,#d6502a);color:#fff;border:2px solid #a83518;border-radius:9px;padding:4px 12px;cursor:pointer;font-family:var(--xsg-font);font-weight:bold;transition:filter 80ms;}',
    '.xsg-btn-danger:hover{filter:brightness(1.08);}',
    '.xsg-btn-warn{background:linear-gradient(180deg,#ffc861,#f09a32);color:#5a3410;border:2px solid #c96a1e;border-radius:9px;padding:4px 12px;cursor:pointer;font-family:var(--xsg-font);font-weight:bold;transition:filter 80ms;}',
    '.xsg-btn-warn:hover{filter:brightness(1.08);}',
    '.xsg-btn-close{background:radial-gradient(circle at 40% 35%,#ff8a4a,#e0531f);color:#fff;border:2px solid #fff2c2;border-radius:50%;width:26px;height:26px;line-height:1;padding:0;cursor:pointer;font-family:var(--xsg-font);font-weight:bold;box-shadow:0 2px 4px rgba(0,0,0,0.35);}',
    '.xsg-btn-close:hover{filter:brightness(1.1);}',
    '.xsg-input,.xsg-select{background:#fffaf0;color:#3f3315;border:2px solid #c98a3e;border-radius:6px;padding:3px 6px;font-family:var(--xsg-font);}',
    '.xsg-input:focus,.xsg-select:focus{outline:none;border-color:#f0922e;}',
    '.xsg-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-bottom:1px solid rgba(90,130,40,0.40);border-radius:6px;}',
    '.xsg-row:hover{background:rgba(255,255,255,0.30);}',
    '.xsg-muted{color:#5e6b2e;}',
    '.xsg-gold{color:var(--xsg-gold);font-weight:bold;}',
    '.xsg-cyan{color:var(--xsg-accent);font-weight:bold;}',
    '.xsg-toast{background:var(--xsg-shell);color:var(--xsg-ink);font-family:var(--xsg-font);border:3px solid var(--xsg-shell-edge);border-radius:12px;padding:10px 12px;box-shadow:0 6px 20px rgba(0,0,0,0.5);}',
  ].join('\n');

  const style = document.createElement('style');
  style.id = 'xsg-online-theme-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  const G = window.XdRsOnline;
  if (G && G.Util && typeof G.Util.log === 'function') {
    G.Util.log('info', '[Theme] XSG orange-green UI theme injected');
  }
})();
