import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';

// 发布物根目录: 默认 <cwd>/releases (pm2 在 server/ 启动, 即 server/releases)。
// 里面放: manifest.json (或 manifest.<channel>.json) + 各版本 zip 包。
const RELEASES_DIR = path.resolve(process.env.RELEASES_DIR || './releases');

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function safeName(name: string): string | null {
  // 只允许单层文件名, 拒绝路径穿越
  if (!name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return name;
}

function contentTypeFor(name: string): string {
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

type FileEntry = { file?: string; [k: string]: unknown };
type Manifest = { full?: FileEntry; patches?: FileEntry[]; latest?: string; [k: string]: unknown };
type Announcement = {
  id?: string; // 公告唯一标识; 客户端据此记住"忽略本条", 换 id 即恢复弹出
  title?: string;
  body?: string;
  date?: string;
  version?: string;
  show?: boolean;
  [k: string]: unknown;
};

// 云更新分流：配置 UPDATE_CDN_BASE 后，把 manifest 里的下载文件名改写成 CDN/R2 绝对 URL。
// 客户端(XdRs_Online_Update)见到 http(s):// 开头会直接从该 URL 下载，绕过本服务器、省公网带宽。
// 空文件名 / 已是绝对 URL 的原样保留；未配置 base 时整体原样返回（回退本地 /update/download）。
function toCdnUrl(fileName: string): string {
  const base = config.updateCdnBase.replace(/\/+$/, '');
  if (!base || !fileName || /^https?:\/\//i.test(fileName)) return fileName;
  return base + '/' + encodeURIComponent(fileName);
}

function applyCdnBase(mf: Manifest): Manifest {
  if (!config.updateCdnBase) return mf;
  const out: Manifest = { ...mf };
  if (out.full && typeof out.full.file === 'string') {
    out.full = { ...out.full, file: toCdnUrl(out.full.file) };
  }
  if (Array.isArray(out.patches)) {
    out.patches = out.patches.map((p) =>
      p && typeof p.file === 'string' ? { ...p, file: toCdnUrl(p.file) } : p,
    );
  }
  return out;
}

// 公告系统: releases/announcement.json (或 announcement.<channel>.json) 可随时手编,
// 无需重打包/重发客户端。/update/manifest 命中时合并下发:
//   - announcement 结构字段供新客户端富展示(标题+正文+日期);
//   - 同步把正文写进 manifest.notes, 让仍在用旧客户端的玩家也能看到公告。
// 文件缺失 / 解析失败时静默忽略(不影响 manifest 主体)。
function loadAnnouncement(channel: string): Announcement | null {
  const candidates = [
    path.join(RELEASES_DIR, `announcement.${channel}.json`),
    path.join(RELEASES_DIR, 'announcement.json'),
  ];
  for (const f of candidates) {
    try {
      if (!fs.statSync(f).isFile()) continue;
      let raw = fs.readFileSync(f, 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // 容忍 PowerShell UTF-8 BOM
      const obj = JSON.parse(raw) as Announcement;
      if (obj && typeof obj === 'object') return obj;
    } catch {
      // 忽略缺失 / 损坏的公告文件
    }
  }
  return null;
}

/**
 * 处理云更新相关 HTTP 路由。命中并已响应返回 true, 否则返回 false 交回主路由。
 *   GET /update/manifest?channel=stable[&cur=1.5.2]   -> 返回 manifest JSON
 *   GET /update/download/<file>                       -> 下载发布包, 支持 Range 断点续传
 */
export function handleUpdate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const method = req.method || 'GET';
  let url: URL;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return false;
  }
  const pathname = url.pathname;

  // ---- GET /update/manifest ----
  if (pathname === '/update/manifest') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }
    const rawChannel = url.searchParams.get('channel') || 'stable';
    const channel = rawChannel.replace(/[^A-Za-z0-9_-]/g, '') || 'stable';
    const cur = url.searchParams.get('cur') || '';

    const candidates = [
      path.join(RELEASES_DIR, `manifest.${channel}.json`),
      path.join(RELEASES_DIR, 'manifest.json'),
    ];
    const file = candidates.find((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });
    if (!file) {
      sendJson(res, 404, { ok: false, error: 'no manifest for channel ' + channel });
      return true;
    }
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
      const out = applyCdnBase(obj);
      // 合并公告(可随时改 announcement.json, 不需重发版本)。
      const ann = loadAnnouncement(channel);
      if (ann && ann.show !== false && (ann.body || ann.title)) {
        out.announcement = ann;
        const composed = (ann.title ? String(ann.title) + '\n\n' : '') + String(ann.body || '');
        if (composed.trim()) out.notes = composed; // 旧客户端只读 notes, 也能看到公告
      }
      log.info(
        {
          channel,
          cur,
          latest: out.latest,
          cdn: config.updateCdnBase ? true : false,
          ann: ann ? true : false,
        },
        'update manifest served',
      );
      sendJson(res, 200, { ok: true, ...out });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { ok: false, error: 'manifest parse failed: ' + msg });
    }
    return true;
  }

  // ---- GET /update/download/<file> ----
  const DL_PREFIX = '/update/download/';
  if (pathname.startsWith(DL_PREFIX)) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }
    const name = safeName(decodeURIComponent(pathname.slice(DL_PREFIX.length)));
    if (!name) {
      sendJson(res, 400, { ok: false, error: 'bad file name' });
      return true;
    }
    const full = path.join(RELEASES_DIR, name);
    // 双保险: 解析后仍必须落在 RELEASES_DIR 内
    if (path.relative(RELEASES_DIR, full).startsWith('..')) {
      sendJson(res, 400, { ok: false, error: 'bad path' });
      return true;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return true;
    }
    if (!st.isFile()) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return true;
    }

    const total = st.size;
    const ctype = contentTypeFor(name);
    const lastModified = st.mtime.toUTCString();
    const etag = '"' + total.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const range = req.headers['range'];
    const ifRange = req.headers['if-range'];
    // If-Range: 校验器(ETag 或 Last-Modified)不匹配则忽略 Range, 回 200 全量(客户端会从头覆盖)。
    const ifRangeOk = typeof ifRange !== 'string' || ifRange === etag || ifRange === lastModified;

    if (ifRangeOk && typeof range === 'string' && range.startsWith('bytes=')) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (!Number.isFinite(start) || start < 0) start = 0;
        if (!Number.isFinite(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          res.writeHead(416, { 'content-range': `bytes */${total}` });
          res.end();
          return true;
        }
        res.writeHead(206, {
          'content-type': ctype,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          'etag': etag,
          'last-modified': lastModified,
        });
        if (method === 'HEAD') {
          res.end();
          return true;
        }
        const stream = fs.createReadStream(full, { start, end });
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return true;
      }
    }

    res.writeHead(200, {
      'content-type': ctype,
      'content-length': String(total),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'etag': etag,
      'last-modified': lastModified,
    });
    if (method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = fs.createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return true;
  }

  return false;
}
