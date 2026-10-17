import { createServer } from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { attachRealtime } from './modules/realtime/server.js';
import { retryDeliveredMediaCleanup } from './modules/chat/routes.js';

const server = createServer(app);
attachRealtime(server);
server.listen(env.port, env.host, () => {
  console.log(`ADDA backend listening on port ${env.port}`);
  void retryDeliveredMediaCleanup().catch(error => console.warn('[ADDA] Media cleanup retry failed:', error));
});
const mediaCleanupTimer = setInterval(() => {
  void retryDeliveredMediaCleanup().catch(error => console.warn('[ADDA] Media cleanup retry failed:', error));
}, 10 * 60_000);

function shutdown() {
  clearInterval(mediaCleanupTimer);
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
