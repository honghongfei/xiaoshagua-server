import http from 'node:http';
import { Server } from 'socket.io';
import { config } from '../config.js';
import { log } from '../log.js';
import { listOnline, resume as resumeSession } from '../domain/player/playerService.js';
import { stats as worldStats } from '../domain/world/worldService.js';
import { uploadSave } from '../domain/storage/storageService.js';
import { installRouter } from './router.js';
import { handleUpdate } from './updateRoute.js';

// H8 修：/stats 加 basic auth (token 来自 .env 的 STATS_TOKEN, 空则要求公网必须本机访问)
const STATS_TOKEN = process.env.STATS_TOKEN || '';
function statsAuthOk(req: http.IncomingMessage): boolean {
  // 本机回环不需要鉴权
  const remote = req.socket.remoteAddress || '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;
  if (!STATS_TOKEN) return false;
  // Authorization: Bearer <token>
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string') return false;
  const expect = 'Bearer ' + STATS_TOKEN;
  return header === expect;
}

export interface ServerHandle {
  http: http.Server;
  io: Server;
  close: () => Promise<void>;
}

const startedAt = Date.now();

function buildStats(): Record<string, unknown> {
  const ws = worldStats();
  const mem = process.memoryUsage();
  return {
    ok: true,
    ts: Date.now(),
    uptimeMs: Date.now() - startedAt,
    env: config.env,
    online: listOnline().length,
    maps: ws.maps,
    playersOnMaps: ws.players,
    memRssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    memHeapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
  };
}

export function startServer(): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => {
      // 云更新: GET /update/manifest, GET /update/download/<file> (含 Range 断点续传)
      if (handleUpdate(req, res)) return;
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: Date.now() }));
        return;
      }
      if (req.url === '/stats') {
        if (!statsAuthOk(req)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(buildStats()));
        return;
      }
      // H4 修：POST /save -- beforeunload 用 navigator.sendBeacon 走这个端点
      // body = { token, contents, meta }
      if (req.url === '/save' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        let totalLen = 0;
        const MAX = 4 * 1024 * 1024;
        req.on('data', (c: Buffer) => {
          totalLen += c.length;
          if (totalLen > MAX) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || typeof body.token !== 'string' || typeof body.contents !== 'string') {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'bad payload' }));
              return;
            }
            const { session } = resumeSession(body.token);
            const baseTs = typeof body.baseTs === 'number' ? body.baseTs : undefined;
            const blob = uploadSave(session.characterId, body.contents, body.meta, baseTs);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ts: blob.ts }));
          } catch (e: any) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e && e.message || 'error' }));
          }
        });
        req.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    // H8 修：CORS 改为 .env 控制；CORS_ORIGIN=* 仍允许 (兼容老配置)
    const corsOrigin = process.env.CORS_ORIGIN || '*';
    // H7 修：与 SaveUpload schema 上限 (2,000,000 chars) 对齐；UTF-8 最坏 4x，留 4MB 缓冲
    const io = new Server(httpServer, {
      cors: { origin: corsOrigin === '*' ? '*' : corsOrigin.split(','), credentials: corsOrigin !== '*' },
      pingInterval: 20_000,
      pingTimeout: 60_000,
      maxHttpBufferSize: 4 * 1024 * 1024,
    });

    installRouter(io);

    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      log.info({ host: config.host, port: config.port }, 'http+ws listening');
      resolve({
        http: httpServer,
        io,
        close: () =>
          new Promise<void>((res) => {
            io.close(() => {
              httpServer.close(() => res());
            });
          }),
      });
    });
  });
}
