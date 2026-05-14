#!/usr/bin/env node
// 用法：node cdp-eval.mjs "<js-expr>"
// 通过 NW.js 的 --remote-debugging-port=9222 远程执行 JS

import http from 'node:http';
import fs from 'node:fs';
import { WebSocket } from 'ws';

let expr;
const args = process.argv.slice(2);
if (args[0] === '--file' && args[1]) {
  expr = fs.readFileSync(args[1], 'utf8');
} else {
  expr = args.join(' ') || '1+1';
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

const tabs = JSON.parse(await get('http://127.0.0.1:9222/json/list'));
const main = tabs.find((t) => t.type === 'page') || tabs[0];
if (!main) { console.error('no debuggable page'); process.exit(1); }

const ws = new WebSocket(main.webSocketDebuggerUrl);

await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let id = 1;
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = id++;
    const handler = (msg) => {
      const m = JSON.parse(msg.toString());
      if (m.id !== mid) return;
      ws.off('message', handler);
      if (m.error) reject(m.error);
      else resolve(m.result);
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

await call('Runtime.enable');

const r = await call('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
  generatePreview: true,
  silent: false,
});

if (r.exceptionDetails) {
  console.log('=== EXCEPTION ===');
  console.log(JSON.stringify(r.exceptionDetails, null, 2));
} else {
  console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
}

ws.close();
