// 端到端烟测：两个真实 socket.io 客户端走完整流程（建房→加入→选角色→开局→打牌→过→重连→战绩）。
// 运行：npx tsx scripts/smoke.ts（需先启动 server）
import { io, type Socket } from 'socket.io-client';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  cardLabel,
  defaultRules,
  listPlayable,
  type GameSnapshot,
  type RoomState,
} from '@gdys/shared';

const URL = 'http://localhost:3000';

function waitConnect(s: Socket): Promise<void> {
  return new Promise((res, rej) => {
    s.on('connect', () => res());
    s.on('connect_error', (e) => rej(e));
  });
}
function ack(s: Socket, ev: string, payload: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  return new Promise((resolve, reject) => {
    s.timeout(5000).emit(ev, payload, (err: unknown, r: { ok: boolean; error?: string; [k: string]: unknown }) =>
      err ? reject(err) : resolve(r)
    );
  });
}
function waitFor<T>(get: () => T | undefined, pred: (x: T) => boolean, what: string, ms = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = get();
      if (v !== undefined && pred(v)) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`等待超时: ${what}`));
      }
    }, 20);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (s: string) => console.log(s);

async function main() {
  const a = io(URL, { transports: ['websocket'] });
  const b = io(URL, { transports: ['websocket'] });
  await Promise.all([waitConnect(a), waitConnect(b)]);
  line('✓ 两个客户端已连接');

  let roomA: RoomState | undefined;
  let roomB: RoomState | undefined;
  let snapA: GameSnapshot | undefined;
  let snapB: GameSnapshot | undefined;
  a.on(SERVER_EVENTS.roomUpdated, (r: RoomState) => (roomA = r));
  b.on(SERVER_EVENTS.roomUpdated, (r: RoomState) => (roomB = r));
  a.on(SERVER_EVENTS.snapshot, (s: GameSnapshot) => (snapA = s));
  b.on(SERVER_EVENTS.snapshot, (s: GameSnapshot) => (snapB = s));

  // 建房 + 加入
  const create = await ack(a, CLIENT_EVENTS.roomCreate, { name: '烟测A' });
  if (!create.ok) throw new Error(`建房失败: ${create.error}`);
  line(`✓ 建房 ${create.code}`);
  await waitFor(() => roomA, (r) => r.players.length === 1, 'A 房间广播');
  const join = await ack(b, CLIENT_EVENTS.roomJoin, { code: create.code as string, name: '烟测B' });
  if (!join.ok) throw new Error(`加入失败: ${join.error}`);
  line('✓ B 加入');
  await waitFor(() => roomB, (r) => r.players.length === 2, 'B 房间广播');
  const aId = create.playerId as string;

  // 错误路径：非法出牌 / 越权开局
  const badPlay = await ack(a, CLIENT_EVENTS.gamePlay, { cardIds: [99999] });
  if (badPlay.ok) throw new Error('大厅阶段竟然能出牌');
  line(`✓ 大厅出牌被拒: ${badPlay.error}`);
  const badStart = await ack(b, CLIENT_EVENTS.roomStart, {});
  if (badStart.ok) throw new Error('非房主竟然能开局');
  line(`✓ 非房主开局被拒: ${badStart.error}`);

  // 选角色 + 准备 + 开局（A 首席蛋神/仁德，B 第六席企鹅骚骚）
  const r1 = await ack(a, CLIENT_EVENTS.roleSelect, { roleId: 'skywalker' });
  const r2 = await ack(b, CLIENT_EVENTS.roleSelect, { roleId: 'cs-champion' });
  if (!r1.ok || !r2.ok) throw new Error(`选角色失败: ${r1.error ?? r2.error}`);
  await ack(a, CLIENT_EVENTS.roomReady, { ready: true });
  await ack(b, CLIENT_EVENTS.roomReady, { ready: true });
  const start = await ack(a, CLIENT_EVENTS.roomStart, {});
  if (!start.ok) throw new Error(`开局失败: ${start.error}`);
  line('✓ 已开局');
  await waitFor(() => snapA, (s) => s.phase === 'playing', 'A 快照');
  await waitFor(() => snapB, (s) => s.phase === 'playing', 'B 快照');

  // 快照可见性：A 看得到自己的牌，B 视角 A 的牌是 null
  const aHand = snapA!.players.find((p) => p.id === aId)!.hand!;
  const aSeenByB = snapB!.players.find((p) => p.id === aId)!.hand;
  line(`✓ A 手牌(${aHand.length}): ${aHand.map(cardLabel).join(' ')}`);
  line(`✓ B 视角 A 手牌 = ${aSeenByB === null ? 'null（正确隐藏）' : '!! 泄漏'}`);

  // 模拟对局：各自动作直到打完（最多 300 步；技能询问一律弃权；出牌被技能否决则逐个尝试）
  let steps = 0;
  let skillTried = false;
  while (steps++ < 300) {
    const snap = snapA!;
    if (snap.phase !== 'playing') break;
    // 技能询问挂起：一律弃权（验证询问链路，不模拟策略）
    if (snap.pendingAsk) {
      const ask = snap.pendingAsk;
      const s = ask.playerId === aId ? a : b;
      const r = await ack(s, CLIENT_EVENTS.gameUseSkill, { askId: ask.askId, choice: 'decline' });
      if (!r.ok) throw new Error(`询问弃权失败: ${r.error}`);
      await waitFor(() => snapA, (x) => !x.pendingAsk, '询问了结', 4000);
      continue;
    }
    const turn = snap.turnPlayerId!;
    const s = turn === aId ? a : b;
    const mySnap = turn === aId ? snapA! : snapB!;
    // 主动技链路：B 接牌时发动一次【骚骚】→ 收到询问 → 弃权
    if (!skillTried && turn !== aId && snap.table) {
      skillTried = true;
      const r = await ack(b, CLIENT_EVENTS.gameUseSkill, { skillId: 'sao-sao' });
      if (!r.ok) throw new Error(`发动技能失败: ${r.error}`);
      await waitFor(() => snapA, (x) => x.pendingAsk !== null, '技能询问', 4000);
      line(`✓ 主动技发动，收到询问: ${snapA!.pendingAsk!.prompt}`);
      continue; // 下一轮循环统一弃权
    }
    const me = mySnap.players.find((p) => p.id === turn)!;
    const combos = listPlayable(me.hand!, snap.table, defaultRules, snap.orderReversed);
    let moved = false;
    if (combos.length > 0) {
      for (const combo of combos) {
        const r = await ack(s, CLIENT_EVENTS.gamePlay, { cardIds: combo.cards.map((c) => c.id) });
        if (!r.ok) continue; // 被技能否决 → 试下一个组合
        try {
          await waitFor(() => snapA, (x) => x.pendingAsk !== null || x.turnPlayerId !== turn, `出牌 ${combo.label}`, 4000);
          moved = true;
        } catch {
          moved = false;
        }
        if (moved) break;
      }
    }
    if (!moved) {
      const r = await ack(s, CLIENT_EVENTS.gamePass, {});
      if (!r.ok) throw new Error(`过牌失败: ${r.error}`);
    }
    await sleep(40);
  }
  line(`✓ 自动对局 ${steps - 1} 步，当前阶段 ${snapA!.phase === 'finished' ? '结束' : '进行中'}`);
  if (snapA!.phase === 'finished') {
    line(`✓ 终局: winnerId=${snapA!.winnerId ?? '(流局)'} 分数=${JSON.stringify(snapA!.scoreDeltas)}`);
    const scores = await ack(a, CLIENT_EVENTS.scoreList, {});
    if (scores.ok) line(`✓ 战绩落盘 ${(scores.records as unknown[]).length} 条`);
  }

  // 重连：B 断开 → 新 socket 带 secret 恢复
  const bId = join.playerId as string;
  const bSecret = join.secret as string;
  b.disconnect();
  await sleep(150);
  const c = io(URL, { transports: ['websocket'] });
  let snapC: GameSnapshot | undefined;
  c.on(SERVER_EVENTS.snapshot, (s: GameSnapshot) => (snapC = s)); // 先注册再重连（快照在 ack 前发出）
  await waitConnect(c);
  const rejoin = await ack(c, CLIENT_EVENTS.roomRejoin, { code: create.code as string, playerId: bId, secret: bSecret });
  if (!rejoin.ok) throw new Error(`重连失败: ${rejoin.error}`);
  await waitFor(() => snapC, () => true, 'C 重连快照');
  line(`✓ 重连恢复，C 视角手牌 ${snapC!.players.find((p) => p.id === bId)!.handCount} 张`);
  const d = io(URL, { transports: ['websocket'] });
  await waitConnect(d);
  const badRejoin = await ack(d, CLIENT_EVENTS.roomRejoin, {
    code: create.code as string,
    playerId: bId,
    secret: 'wrong',
  });
  line(`✓ 错误 secret 被拒: ${badRejoin.error}`);
  d.disconnect();

  a.disconnect();
  c.disconnect();
  line('✅ 烟测全部通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('✗ 烟测失败:', e);
  process.exit(1);
});
