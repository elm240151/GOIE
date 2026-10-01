// 服务端入口：http + Socket.IO；prod 时托管 client/dist；启动时自动加载全部角色。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { listRoles, type RoleRegistry } from '@gdys/shared';
import { loadAllRoles } from '@gdys/shared/roles/loader.node';
import { RoomManager } from './roomManager';
import { JsonFileScoreStore } from './scoreStore';
import { registerHandlers } from './socketHandlers';

const PORT = Number(process.env.PORT ?? 3000);
const here = fileURLToPath(new URL('.', import.meta.url));
const distDir = join(here, '..', '..', 'client', 'dist');

await loadAllRoles();
const roles: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
const scoreStore = new JsonFileScoreStore(join(here, '..', 'data', 'scores.json'));
const rooms = new RoomManager({ roles, scoreStore });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** prod：托管 client/dist（SPA 回退 index.html） */
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  try {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let file = normalize(join(distDir, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(distDir)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) file = join(distDir, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(500).end();
  }
}

const httpServer = createServer((req, res) => {
  if (existsSync(distDir)) serveStatic(req, res);
  else {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('干瞪眼服务器运行中（开发模式请访问 Vite 端口）');
  }
});

const io = new Server(httpServer, { cors: { origin: '*' } });
registerHandlers(io, rooms);

httpServer.listen(PORT, () => {
  console.log(`干瞪眼服务器已启动: http://localhost:${PORT}（已加载 ${roles.size} 个角色）`);
});
