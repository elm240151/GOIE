// 真实浏览器复现：修勾剩「一张单牌 + 一副炸」→ 打单牌 → 狂吠弹窗是否出现 → 能否选炸接自己获胜
// 运行：npx tsx scripts/browser-doggie-test.ts（自起 3199 测试服 + headless Chrome CDP，不依赖 3000 生产服）
import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import WebSocket from 'ws';
import { CLIENT_EVENTS, SERVER_EVENTS, listRoles, type RoleRegistry } from '@gdys/shared';
import { defaultRules } from '../shared/src/config';
import { loadAllRoles } from '../shared/src/roles/loader.node';
import { GameEngine, type EnginePlayer } from '../shared/src/engine/engine';
import { buildDeck } from '../shared/src/engine/deck';
import { mulberry32 } from '../shared/src/engine/rng';
import { RoomManager } from '../server/src/roomManager';
import { registerHandlers } from '../server/src/socketHandlers';
import { JsonFileScoreStore } from '../server/src/scoreStore';

const PORT = 3199;
const CDP_PORT = 9333;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- CDP 小客户端 ----------
function cdpClient(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map<number, (v: unknown) => void>();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as { id?: number; result?: unknown };
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result);
      pending.delete(msg.id);
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, opened: new Promise<void>((r) => ws.on('open', () => r())) };
}

/** 页面内求值（返回 JSON 化结果） */
async function evalJS(cdp: ReturnType<typeof cdpClient>, expr: string): Promise<unknown> {
  const r = (await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown; subtype?: string }; exceptionDetails?: { text?: string } };
  if (r.exceptionDetails) throw new Error(`页面求值异常: ${r.exceptionDetails.text} expr=${expr.slice(0, 80)}`);
  return r.result?.value;
}

/** 轮询页面条件 */
async function waitFor(cdp: ReturnType<typeof cdpClient>, expr: string, what: string, ms = 6000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evalJS(cdp, expr)) return;
    await sleep(100);
  }
  throw new Error(`等待超时: ${what}`);
}

/** 页面内按文本找按钮并点击 */
async function clickText(cdp: ReturnType<typeof cdpClient>, selector: string, text: string, what: string): Promise<void> {
  const ok = await evalJS(
    cdp,
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent && e.textContent.includes(${JSON.stringify(text)})); if (!el || el.disabled) return false; el.click(); return true; })()`
  );
  if (!ok) throw new Error(`点击失败: ${what}`);
  await sleep(150);
}

async function main() {
  let chrome: ReturnType<typeof spawn> | null = null;
  let httpServer: ReturnType<typeof createServer> | null = null;
  let sio: Server | null = null;
  let b: ReturnType<typeof io> | null = null;
  let cdp: ReturnType<typeof cdpClient> | null = null;
  try {
  // ---------- 1. 起 3199 测试服（强制手牌：A 修勾 [单5 + 炸6666] 先手；B 无牌可压） ----------
  await loadAllRoles();
  const registry: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
  const deck = buildDeck(3);
  const byRank = (r: number, n: number) => deck.filter((c) => c.rank === r).slice(0, n);
  const handA = [...byRank(5, 1), ...byRank(6, 4)];
  const handB = [...byRank(4, 1), ...byRank(3, 8)];
  const factory: (opts: { players: EnginePlayer[]; startPlayerId: string; scores: Record<string, number> }) => GameEngine = ({ players }) =>
    new GameEngine(defaultRules, players, {
      rng: mulberry32(1),
      startPlayerId: players[0]!.id, // A 先手起单 5
      roles: registry,
      scores: {},
      handsOverride: { [players[0]!.id]: handA, [players[1]!.id]: handB },
    });
  const rooms = new RoomManager({
    roles: registry,
    scoreStore: new JsonFileScoreStore(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'tmp-scores-browser-test.json')),
    autoPassMs: 60_000,
    engineFactory: factory,
  });
  const here = fileURLToPath(new URL('.', import.meta.url));
  const distDir = join(here, '..', 'client', 'dist');
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  };
  httpServer = createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      let file = normalize(join(distDir, urlPath === '/' ? 'index.html' : urlPath));
      if (!file.startsWith(distDir)) { res.writeHead(403).end(); return; }
      if (!existsSync(file) || !statSync(file).isFile()) file = join(distDir, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch { res.writeHead(500).end(); }
  });
  sio = new Server(httpServer, { cors: { origin: '*' } });
  registerHandlers(sio, rooms);  await new Promise<void>((r) => httpServer.listen(PORT, () => r()));
  console.log(`[测试服] http://localhost:${PORT} 已启动（A 手牌 = 单5 + 炸6666，A 先手）`);

  // ---------- 2. headless Chrome + CDP ----------
  const profileDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.tmp-cdp-profile');
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try {
      const list = (await (await fetch(`http://localhost:${CDP_PORT}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = list.find((t) => t.type === 'page');
    } catch { /* chrome 还没起好 */ }
  }
  if (!target) throw new Error('Chrome 未就绪（CDP 不可达）');
  cdp = cdpClient(target.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 记录页面异常
  await evalJS(cdp, `window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); true`);
  console.log('[浏览器] headless Chrome 已就绪');

  // ---------- 3. 玩家 B：脚本 socket 加入（A 的 UI 全走浏览器真实点击） ----------
  b = io(`http://localhost:${PORT}`, { transports: ['websocket'] });
  await new Promise<void>((r) => b.on('connect', () => r()));
  b.on(SERVER_EVENTS.skillAsk, (ask: { askId: string }) => {
    // B 收到任何询问一律弃权（本测试焦点是 A 的狂吠弹窗）
    b.emit(CLIENT_EVENTS.gameUseSkill, { askId: ask.askId, choice: 'decline' });
  });

  // ---------- 4. A：浏览器建房 ----------
  await cdp.send('Page.navigate', { url: `http://localhost:${PORT}` });
  await waitFor(cdp, `document.readyState === 'complete'`, '页面加载');
  await evalJS(cdp, `localStorage.setItem('gdys-name', '狗主A'); true`);
  await cdp.send('Page.reload');
  await waitFor(cdp, `document.readyState === 'complete'`, '页面重载');
  await waitFor(cdp, `!!document.querySelector('.lobby-card .btn-primary') && !document.querySelector('.lobby-card .btn-primary').disabled`, '大厅建房按钮可点');
  await evalJS(cdp, `document.querySelector('.lobby-card .btn-primary').click(); true`);
  await waitFor(cdp, `!!document.querySelector('.room-code')`, '进入房间界面');
  const code = String(await evalJS(cdp, `document.querySelector('.room-code').textContent.replace(/\\D/g, '')`));
  console.log(`[浏览器] A 建房成功，房号 ${code}`);

  const joinRes = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    b.timeout(5000).emit(CLIENT_EVENTS.roomJoin, { code, name: '狗友B' }, (_err: unknown, r: { ok: boolean; error?: string }) => resolve(r));
  });
  if (!joinRes.ok) throw new Error(`B 加入失败: ${joinRes.error}`);
  const bRole = listRoles().find((r) => r.id !== 'doggie')!.id;
  await new Promise<void>((resolve) => {
    b.timeout(5000).emit(CLIENT_EVENTS.roleSelect, { roleId: bRole }, () => resolve());
  });
  await new Promise<void>((resolve) => {
    b.timeout(5000).emit(CLIENT_EVENTS.roomReady, { ready: true }, () => resolve());
  });
  console.log(`[B] 已加入并准备（角色 ${bRole}）`);

  // A 选修勾 → 准备 → 开始
  await clickText(cdp, '.role-card', '修勾', 'A 选修勾');
  await waitFor(cdp, `[...document.querySelectorAll('button')].some(b => b.textContent.includes('准备') && !b.disabled)`, '准备按钮可点');
  await clickText(cdp, 'button', '准备', 'A 准备');
  await waitFor(cdp, `[...document.querySelectorAll('button')].some(b => b.textContent.includes('开始') && !b.disabled)`, '开始按钮可点');
  await clickText(cdp, 'button', '开始', 'A 开始游戏');

  // ---------- 5. 关键步骤：A 打单 5 ----------
  await waitFor(cdp, `document.querySelectorAll('.hand .card').length === 5`, 'A 手牌 5 张', 10000);
  console.log('[浏览器] 开局成功，A 手牌 5 张 =', String(await evalJS(cdp, `[...document.querySelectorAll('.hand .card-corner')].map(e => e.textContent).join(',')`)));
  const clicked5 = await evalJS(cdp, `(() => { const c = [...document.querySelectorAll('.hand .card')].find(x => x.querySelector('.card-corner')?.textContent === '5'); if (!c) return false; c.click(); return true; })()`);
  if (!clicked5) throw new Error('没找到单 5');
  await sleep(250);
  await clickText(cdp, '.game-actions button', '出牌', 'A 出单 5');
  console.log('[浏览器] A 已打出单 5');

  // ---------- 6. 狂吠弹窗应出现 ----------
  let modalShown = false;
  try {
    await waitFor(cdp, `!!document.querySelector('.ask-modal')`, '狂吠弹窗出现', 4000);
    modalShown = true;
  } catch {
    modalShown = false;
  }
  console.log(`[关键] 狂吠弹窗出现: ${modalShown ? '✓ 是' : '✗ 否'}`);
  if (!modalShown) {
    const toasts = String(await evalJS(cdp, `[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ') || '(无)')`));
    console.log(`[关键] 页面 toast: ${toasts}`);
    console.log(`[关键] 页面错误: ${String(await evalJS(cdp, `window.__errs.join(' | ') || '(无)'`))}`);
    throw new Error('复现成功：狂吠弹窗没有出现！');
  }

  // ---------- 7. 弹窗里选炸接自己 ----------
  const askText = String(await evalJS(cdp, `document.querySelector('.ask-modal').textContent.slice(0, 80)`));
  console.log(`[浏览器] 弹窗内容: ${askText}`);
  const gridCount = Number(await evalJS(cdp, `document.querySelectorAll('.ask-cards .card').length`));
  console.log(`[浏览器] 弹窗内牌数: ${gridCount}（应为 4 = 炸6666）`);
  if (gridCount !== 4) throw new Error(`弹窗内牌数不对: ${gridCount}`);

  // 7a. 先试一次无效选牌（只选 2 张 6 = 对子，压不过单 5）→ 应收到拒绝并重新询问、弹窗保持打开
  await evalJS(cdp, `[...document.querySelectorAll('.ask-cards .card')].slice(0, 2).forEach(c => c.click()); true`);
  await sleep(200);
  await clickText(cdp, '.ask-actions button', '确定', '无效选牌确定');
  await sleep(600);
  const toastText = String(await evalJS(cdp, `[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ') || '(无)'`));
  console.log(`[浏览器] 无效选牌（对6压单5）后 toast: ${toastText}`);
  const stillOpen = await evalJS(cdp, `!!document.querySelector('.ask-modal')`);
  console.log(`[浏览器] 拒绝后弹窗保持打开（重新询问）: ${stillOpen ? '✓ 是' : '✗ 否'}`);
  if (!stillOpen) throw new Error('拒绝后弹窗被关闭了——重新询问链路断裂！');
  const reaskCards = Number(await evalJS(cdp, `document.querySelectorAll('.ask-cards .card').length`));
  console.log(`[浏览器] 重新询问弹窗内牌数: ${reaskCards}（应为 4，且选中已清空）`);

  // 7b. 选满 4 张炸 → 确定 → 应获胜
  await evalJS(cdp, `[...document.querySelectorAll('.ask-cards .card')].forEach(c => c.click()); true`);
  await sleep(200);
  const submitDisabled = await evalJS(cdp, `!!document.querySelector('.ask-actions .btn-primary')?.disabled`);
  console.log(`[浏览器] 选满 4 张后确定按钮禁用态: ${submitDisabled}（应为 false）`);
  await clickText(cdp, '.ask-actions button', '确定', '狂吠确定');
  await waitFor(cdp, `!!document.querySelector('.finish-modal')`, '终局弹窗（A 应获胜）', 6000);
  const finishText = String(await evalJS(cdp, `document.querySelector('.finish-modal').textContent.slice(0, 60)`));
  console.log(`[关键] 终局: ${finishText}`);
  const errs = String(await evalJS(cdp, `(window.__errs || []).join(' | ') || '(无)'`));
  console.log(`[关键] 页面错误: ${errs}`);

  console.log('=== 浏览器复现结论：狂吠弹窗正常出现、炸接自己正常获胜 ===');
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch { /* 忽略 */ }
      cdp.ws.close();
    }
    if (b) b.disconnect();
    sio?.close(); // 强制断开服务端连接（含浏览器页面），否则 httpServer 关不掉、进程不退出
    if (httpServer) httpServer.close();
    if (chrome) {
      try { execSync(`taskkill /F /T /PID ${chrome.pid}`); } catch { /* 忽略 */ }
    }
  }
}

main().catch((e) => {
  console.error('✗ 失败:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
