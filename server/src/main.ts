import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/sqlite.js';
import { startServer, type ServerHandle } from './gateway/io.js';
import { flushPositions, stopTick } from './domain/world/worldService.js';
import { log } from './log.js';

let handle: ServerHandle | null = null;

async function bootstrap(): Promise<void> {
  const mig = runMigrations();
  log.info(mig, 'db migrations');
  handle = await startServer();

  if (typeof process.send === 'function') {
    process.send('ready');
  }
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  stopTick();
  // 关闭定时器后, 在线玩家的位移还在内存里 (persist 每 60s 才落库一次),
  // 这里同步补刷一次, 避免重启丢最多 60s 的位置.
  try {
    flushPositions();
  } catch (err) {
    log.warn({ err }, 'flushPositions on shutdown failed');
  }
  if (handle) {
    try {
      await handle.close();
    } catch (err) {
      log.warn({ err }, 'close http+ws failed');
    }
  }
  closeDb();
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  log.error({ err }, 'uncaughtException');
});

bootstrap().catch((err) => {
  log.error({ err }, 'bootstrap failed');
  process.exitCode = 1;
});
