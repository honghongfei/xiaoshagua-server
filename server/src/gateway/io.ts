import http from 'node:http';
import { Server } from 'socket.io';
import { config } from '../config.js';
import { log } from '../log.js';
import { listOnline } from '../domain/player/playerService.js';
import { stats as worldStats } from '../domain/world/worldService.js';
import { installRouter } from './router.js';

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
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: Date.now() }));
        return;
      }
      if (req.url === '/stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(buildStats()));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const io = new Server(httpServer, {
      cors: { origin: '*' },
      pingInterval: 20_000,
      pingTimeout: 25_000,
      maxHttpBufferSize: 1e6,
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
