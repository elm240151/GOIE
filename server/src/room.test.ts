import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeck,
  clearRoles,
  defaultRules,
  GameEngine,
  listPlayable,
  listRoles,
  mulberry32,
  SERVER_EVENTS,
  type EnginePlayer,
  type GameEvent,
  type GameSnapshot,
  type RoleRegistry,
  type RoomState,
  type SkillAsk,
} from '@gdys/shared';
import { loadAllRoles } from '@gdys/shared/roles/loader.node';
import { MemoryScoreStore } from './scoreStore';
import { RoomManager } from './roomManager';
import type { RoomOptions } from './room';

interface FakeSocket {
  id: string;
  emit: ReturnType<typeof vi.fn>;
}

function mkSocket(id: string): FakeSocket {
  return { id, emit: vi.fn() };
}

/** 取某个 socket 收到的最近一次指定事件载荷 */
function lastEmit<T>(s: FakeSocket, ev: string): T | undefined {
  for (let i = s.emit.mock.calls.length - 1; i >= 0; i--) {
    const call = s.emit.mock.calls[i]!;
    if (call[0] === ev) return call[1] as T;
  }
  return undefined;
}

/** 该 socket 收到的全部 game:event */
function emittedEvents(s: FakeSocket): GameEvent[] {
  const out: GameEvent[] = [];
  for (const call of s.emit.mock.calls) {
    if (call[0] === SERVER_EVENTS.event) out.push(call[1] as GameEvent);
  }
  return out;
}

let manager: RoomManager;

beforeEach(async () => {
  clearRoles();
  await loadAllRoles();
  const roles: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
  manager = new RoomManager({ roles, scoreStore: new MemoryScoreStore(), autoPassMs: 30_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** 建房 n 人 + 全员选角色 + 全员准备 */
function setupRoom(n: number): { sockets: FakeSocket[]; ids: string[]; secrets: Record<string, string>; code: string } {
  const sockets = Array.from({ length: n }, (_, i) => mkSocket(`s${i}`));
  const { code, playerId, secret } = manager.create('玩家1', sockets[0]!);
  const ids = [playerId];
  const secrets: Record<string, string> = { [playerId]: secret };
  for (let i = 1; i < n; i++) {
    const r = manager.join(code, `玩家${i + 1}`, sockets[i]!);
    ids.push(r.playerId);
    secrets[r.playerId] = r.secret;
  }
  const roleIds = ['skywalker', 'elm-yao', 'unhumanity', 'flashpoint', 'yy-xue', 'cs-champion'];
  for (let i = 0; i < n; i++) manager.selectRole(sockets[i]!.id, roleIds[i % roleIds.length]!);
  for (const s of sockets) manager.setReady(s.id, true);
  return { sockets, ids, secrets, code };
}

/** 模拟打完整局（每次取最小可出组合；技能询问一律弃权；被技能否决则逐个尝试），返回终局房态 */
function runUntilFinished(setup: ReturnType<typeof setupRoom>): RoomState {
  let guard = 0;
  while (true) {
    if (++guard > 5000) throw new Error('模拟未收敛');
    const st = lastEmit<RoomState>(setup.sockets[0]!, SERVER_EVENTS.roomUpdated);
    if (st?.phase === 'finished') return st;
    const snap = lastEmit<GameSnapshot>(setup.sockets[0]!, SERVER_EVENTS.snapshot)!;
    // 技能询问挂起：被询问者一律弃权
    if (snap.pendingAsk) {
      const ask = snap.pendingAsk;
      const idx = setup.ids.indexOf(ask.playerId);
      manager.useSkill(setup.sockets[idx]!.id, { askId: ask.askId, choice: 'decline' });
      continue;
    }
    const turnId = snap.turnPlayerId!;
    const idx = setup.ids.indexOf(turnId);
    const mySnap = lastEmit<GameSnapshot>(setup.sockets[idx]!, SERVER_EVENTS.snapshot)!;
    const me = mySnap.players.find((p) => p.id === turnId)!;
    const combos = listPlayable(me.hand!, mySnap.table, defaultRules);
    if (combos.length === 0) {
      manager.pass(setup.sockets[idx]!.id);
      continue;
    }
    // 逐个尝试（技能否决可能拦下部分组合），回合推进即成功
    let moved = false;
    for (const combo of combos) {
      manager.play(setup.sockets[idx]!.id, combo.cards.map((c) => c.id));
      const s2 = lastEmit<GameSnapshot>(setup.sockets[0]!, SERVER_EVENTS.snapshot)!;
      if (s2.pendingAsk || s2.turnPlayerId !== turnId) {
        moved = true;
        break;
      }
    }
    if (!moved) manager.pass(setup.sockets[idx]!.id);
  }
}

/** 固定手牌 2 人局（观股询问专用）：
 *  房主（末席 肖亡）[♠3,♠9,♠10,♠J,♠Q] 先手；下家 [♥3,♣3,♦3,♠3,♥3(第二副)] 无牌可压。
 *  房主出单3 → 下家过 → 一轮结束 → 观股询问房主。
 *  剩余牌堆尾 5 张 = ♦K♦A♦2小王大王（4 红 1 黑）→ 同意必大涨。 */
function mkFixedSetup(): { manager: RoomManager; sockets: FakeSocket[]; ids: string[]; secrets: Record<string, string>; code: string } {
  const registry: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
  const deck = buildDeck(3);
  const pick = (ids: number[]) => ids.map((id) => deck[id]!);
  const p0Hand = pick([0, 6, 7, 8, 9]);
  const p1Hand = pick([1, 2, 3, 54, 55]);
  const factory: RoomOptions['engineFactory'] = ({ players }) =>
    new GameEngine(defaultRules, players, {
      rng: mulberry32(1),
      startPlayerId: players[0]!.id, // 固定先手 = 房主（handsOverride 不定先手，这里显式钉住）
      roles: registry,
      scores: {},
      handsOverride: { [players[0]!.id]: p0Hand, [players[1]!.id]: p1Hand },
    });
  const mgr = new RoomManager({
    roles: registry,
    scoreStore: new MemoryScoreStore(),
    autoPassMs: 30_000,
    engineFactory: factory,
  });
  const sockets = [mkSocket('s0'), mkSocket('s1')];
  const { code, playerId, secret } = mgr.create('房主', sockets[0]!);
  const ids = [playerId];
  const secrets: Record<string, string> = { [playerId]: secret };
  const r1 = mgr.join(code, '玩家2', sockets[1]!);
  ids.push(r1.playerId);
  secrets[r1.playerId] = r1.secret;
  mgr.selectRole(sockets[0]!.id, 'zecheng');
  mgr.selectRole(sockets[1]!.id, 'flashpoint');
  for (const s of sockets) mgr.setReady(s.id, true);
  return { manager: mgr, sockets, ids, secrets, code };
}

/** 固定局：房主出单3，下家过，进入观股询问 */
function playToZechengAsk(s: ReturnType<typeof mkFixedSetup>): { ask: SkillAsk; handCount: number } {
  s.manager.startGame(s.sockets[0]!.id);
  const snap0 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
  expect(snap0.turnPlayerId).toBe(s.ids[0]);
  const hostHand = snap0.players.find((p) => p.id === s.ids[0])!.hand!;
  s.manager.play(s.sockets[0]!.id, [hostHand.find((c) => c.rank === 3)!.id]);
  s.manager.pass(s.sockets[1]!.id);
  const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
  expect(mid.pendingAsk).toBeTruthy();
  expect(mid.pendingAsk!.playerId).toBe(s.ids[0]);
  const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
  expect(ask.askId).toBe(mid.pendingAsk!.askId);
  return { ask, handCount: mid.players.find((p) => p.id === s.ids[0])!.handCount };
}

/** 全员投票再来一局 → 回房间重新准备 → 房主开局（模拟一局接一局） */
function rematchAll(setup: ReturnType<typeof setupRoom>): void {
  for (const s of setup.sockets) manager.rematch(s.id);
  for (const s of setup.sockets) manager.setReady(s.id, true);
  manager.startGame(setup.sockets[0]!.id);
}

describe('大厅流程', () => {
  it('建房：6 位房间号，房主就座并广播状态', () => {
    const s = mkSocket('s0');
    const res = manager.create('小明', s);
    expect(res.code).toMatch(/^\d{6}$/);
    expect(res.playerId).toBeTruthy();
    expect(res.secret).toBeTruthy();
    const st = lastEmit<RoomState>(s, SERVER_EVENTS.roomUpdated)!;
    expect(st.code).toBe(res.code);
    expect(st.phase).toBe('lobby');
    expect(st.players).toHaveLength(1);
    expect(st.players[0]).toMatchObject({ name: '小明', isHost: true, connected: true, ready: false });
    expect(st.hostId).toBe(res.playerId);
  });

  it('加入：重名/错误房号/满员拒绝', () => {
    const host = mkSocket('s0');
    const { code } = manager.create('房主', host);
    expect(() => manager.join(code, '房主', mkSocket('s1'))).toThrow('名字已被使用');
    const p1 = mkSocket('s1');
    expect(manager.join(code, '玩家2', p1).code).toBe(code);
    expect(() => manager.join('000000', '玩家3', mkSocket('s2'))).toThrow('房间不存在');
    for (let i = 3; i <= 6; i++) manager.join(code, `玩家${i}`, mkSocket(`s${i}`));
    expect(() => manager.join(code, '玩家7', mkSocket('s7'))).toThrow('房间已满');
  });

  it('角色：同角色一房限一个，未注册角色拒绝', () => {
    const host = mkSocket('s0');
    const { code } = manager.create('房主', host);
    const p1 = mkSocket('s1');
    manager.join(code, '玩家2', p1);
    manager.selectRole(host.id, 'skywalker');
    expect(() => manager.selectRole(p1.id, 'skywalker')).toThrow('已被别人选择');
    expect(() => manager.selectRole(p1.id, 'no-such-role')).toThrow('角色不存在');
    manager.selectRole(p1.id, 'elm-yao');
  });

  it('开局：房主专属、至少 2 人、全员准备且选角色', () => {
    const host = mkSocket('s0');
    const { code, playerId: hostId } = manager.create('房主', host);
    expect(() => manager.startGame(host.id)).toThrow('至少需要 2');
    const p1 = mkSocket('s1');
    const { playerId: p1Id } = manager.join(code, '玩家2', p1);
    manager.setReady(host.id, true);
    manager.setReady(p1.id, true);
    expect(() => manager.startGame(host.id)).toThrow('未选角色');
    manager.selectRole(host.id, 'skywalker');
    manager.selectRole(p1.id, 'elm-yao');
    manager.setReady(p1.id, false);
    expect(() => manager.startGame(host.id)).toThrow('未准备');
    manager.setReady(p1.id, true);
    expect(() => manager.startGame(p1.id)).toThrow('只有房主');
    manager.startGame(host.id);
    const st = lastEmit<RoomState>(host, SERVER_EVENTS.roomUpdated)!;
    expect(st.phase).toBe('playing');
    const snap = lastEmit<GameSnapshot>(host, SERVER_EVENTS.snapshot)!;
    // 首局先手 = 房主
    expect(snap.roundLeaderId).toBe(hostId);
    // 先手 6 张，其余 5 张
    expect(snap.players.find((x) => x.id === snap.roundLeaderId)!.handCount).toBe(6);
    expect(snap.players.filter((x) => x.id !== snap.roundLeaderId).every((x) => x.handCount === 5)).toBe(true);
    // 手牌可见性：只看得到自己的
    expect(snap.players.find((x) => x.id === hostId)!.hand).not.toBeNull();
    expect(snap.players.find((x) => x.id === p1Id)!.hand).toBeNull();
    // 开局事件广播
    const events = emittedEvents(host);
    expect(events.some((e) => e.type === 'game:started')).toBe(true);
    expect(events.some((e) => e.type === 'deal:done')).toBe(true);
  });
});

describe('完整对局', () => {
  it('模拟打完一局：终局记分零和、战绩落盘', async () => {
    const setup = setupRoom(3);
    manager.startGame(setup.sockets[0]!.id);
    // 极小概率流局（全员纯王无法起牌）→ 再来一局直到分出胜负
    let st = runUntilFinished(setup);
    for (let draws = 0; !st.winnerId && draws < 5; draws++) {
      rematchAll(setup);
      st = runUntilFinished(setup);
    }
    expect(st.phase).toBe('finished');
    expect(st.winnerId).toBeTruthy();
    const deltas = st.scoreDeltas!;
    expect(setup.ids.reduce((sum, id) => sum + deltas[id]!, 0)).toBe(0); // 零和
    expect(deltas[st.winnerId!]).toBe(2); // 3 人局赢家 +2
    expect(st.totals[st.winnerId!]).toBe(2);
    const events = emittedEvents(setup.sockets[0]!);
    const ended = [...events].reverse().find((e) => e.type === 'game:ended') as
      | { winnerId: string | null }
      | undefined;
    expect(ended?.winnerId).toBe(st.winnerId);
    const records = await manager.listScores();
    const last = records[records.length - 1]!;
    expect(last.winnerId).toBe(st.winnerId);
    expect(last.roomId).toBe(setup.code);
    expect(last.players).toHaveLength(3);
  });

  it('再来一局：全员投票回房间可重选角色，重新开局后先手给上局赢家', () => {
    const setup = setupRoom(3);
    manager.startGame(setup.sockets[0]!.id);
    let st = runUntilFinished(setup);
    for (let draws = 0; !st.winnerId && draws < 5; draws++) {
      rematchAll(setup);
      st = runUntilFinished(setup);
    }
    const winner = st.winnerId!;
    manager.rematch(setup.sockets[0]!.id);
    manager.rematch(setup.sockets[1]!.id);
    expect(lastEmit<RoomState>(setup.sockets[0]!, SERVER_EVENTS.roomUpdated)!.phase).toBe('finished');
    manager.rematch(setup.sockets[2]!.id);
    const st2 = lastEmit<RoomState>(setup.sockets[0]!, SERVER_EVENTS.roomUpdated)!;
    expect(st2.phase).toBe('lobby'); // 回房间，不自动开局
    expect(st2.players.every((p) => !p.ready)).toBe(true); // 全员需重新准备
    // 回房间后可重选角色
    manager.selectRole(setup.sockets[0]!.id, 'flashpoint');
    const st3 = lastEmit<RoomState>(setup.sockets[0]!, SERVER_EVENTS.roomUpdated)!;
    expect(st3.players.find((p) => p.id === setup.ids[0])!.roleId).toBe('flashpoint');
    // 重新准备 + 房主开局 → 先手仍给上局赢家
    for (const s of setup.sockets) manager.setReady(s.id, true);
    manager.startGame(setup.sockets[0]!.id);
    const snap = lastEmit<GameSnapshot>(setup.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.roundLeaderId).toBe(winner);
    expect(snap.totals[winner]).toBe(2); // 累计分跨局保留
  });
});

describe('技能询问（观股）', () => {
  it('轮末最后出牌者收到询问，同意大涨后依次自选每人 1 张', () => {
    const s = mkFixedSetup();
    const { ask, handCount } = playToZechengAsk(s);
    expect(ask.kind).toBe('confirm');
    expect(handCount).toBe(4); // 出单3后剩 4 张
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'yes' });
    // 大涨：先问房主自己（askPlayerId 定向），询问发到被询问者 socket
    const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid.pendingAsk?.playerId).toBe(s.ids[0]);
    const ask1 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask1.kind).toBe('pickCards');
    expect(ask1.cards).toHaveLength(5);
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask1.askId!, cardIds: [ask1.cards![0]!.id] });
    // 再问下家
    const mid2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid2.pendingAsk?.playerId).toBe(s.ids[1]);
    const ask2 = lastEmit<SkillAsk>(s.sockets[1]!, SERVER_EVENTS.skillAsk)!;
    expect(ask2.kind).toBe('pickCards');
    expect(ask2.cards).toHaveLength(4);
    expect(ask2.cards!.some((c) => c.id === ask1.cards![0]!.id)).toBe(false); // 已选走的不再可选
    s.manager.useSkill(s.sockets[1]!.id, { askId: ask2.askId!, cardIds: [ask2.cards![0]!.id] });
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    const counts = Object.fromEntries(after.players.map((p) => [p.id, p.handCount]));
    expect(counts[s.ids[0]!]).toBe(5); // 4 + 大涨 1 张（摸牌被替代）
    expect(counts[s.ids[1]!]).toBe(6); // 5 + 大涨 1 张
    expect(after.deckCount).toBe(162 - 10 - 5); // 发牌 10 张后展示 5 张
  });

  it('询问超时自动弃权：正常摸 1 张', () => {
    vi.useFakeTimers();
    const s = mkFixedSetup();
    const { handCount } = playToZechengAsk(s);
    expect(handCount).toBe(4);
    vi.advanceTimersByTime(15_001); // 技能询问超时（skillAskMs = 15s）
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    const counts = Object.fromEntries(after.players.map((p) => [p.id, p.handCount]));
    expect(counts[s.ids[0]!]).toBe(5); // 4 + 正常摸 1 张
    expect(counts[s.ids[1]!]).toBe(5);
  });

  it('大涨自选超时：自动拿剩余最小牌，队列继续走完', () => {
    vi.useFakeTimers();
    const s = mkFixedSetup();
    const { ask } = playToZechengAsk(s);
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'yes' });
    const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid.pendingAsk?.playerId).toBe(s.ids[0]); // 先问房主自己
    const ask1 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    const min0 = [...ask1.cards!].sort((x, y) => (x.rank !== y.rank ? x.rank - y.rank : x.suit - y.suit))[0]!; // ♦K
    vi.advanceTimersByTime(15_001); // 房主超时 → 自动拿最小 → 接着问下家
    const mid2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid2.pendingAsk?.playerId).toBe(s.ids[1]);
    vi.advanceTimersByTime(15_001); // 下家也超时 → 自动拿最小 → 队列走完
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    const counts = Object.fromEntries(after.players.map((p) => [p.id, p.handCount]));
    expect(counts[s.ids[0]!]).toBe(5); // 4 + 自动拿最小 1 张
    expect(counts[s.ids[1]!]).toBe(6); // 5 + 自动拿最小 1 张
    expect(after.deckCount).toBe(162 - 10 - 5);
    const hostHand = after.players.find((p) => p.id === s.ids[0]!)!.hand!;
    expect(hostHand.some((c) => c.id === min0.id)).toBe(true); // 拿到的是 5 张里最小的
  });

  it('重连：未决询问重新发给本人，可继续回答', () => {
    const s = mkFixedSetup();
    playToZechengAsk(s);
    s.manager.disconnect(s.sockets[0]!.id);
    const back = mkSocket('s-back');
    s.manager.rejoin(s.code, s.ids[0]!, s.secrets[s.ids[0]!]!, back);
    const ask = lastEmit<SkillAsk>(back, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('confirm');
    s.manager.useSkill(back.id, { askId: ask.askId!, choice: 'yes' });
    // 大涨自选询问重新发给重连者（先问房主自己）
    const ask1 = lastEmit<SkillAsk>(back, SERVER_EVENTS.skillAsk)!;
    expect(ask1.kind).toBe('pickCards');
    s.manager.useSkill(back.id, { askId: ask1.askId!, cardIds: [ask1.cards![0]!.id] });
    // 下家自选
    const ask2 = lastEmit<SkillAsk>(s.sockets[1]!, SERVER_EVENTS.skillAsk)!;
    expect(ask2.kind).toBe('pickCards');
    s.manager.useSkill(s.sockets[1]!.id, { askId: ask2.askId!, cardIds: [ask2.cards![0]!.id] });
    const after = lastEmit<GameSnapshot>(back, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    const counts = Object.fromEntries(after.players.map((p) => [p.id, p.handCount]));
    expect(counts[s.ids[0]!]).toBe(5);
    expect(counts[s.ids[1]!]).toBe(6);
  });
});

describe('重连与掉线兜底', () => {
  it('重连：secret 校验并恢复；掉线超时自动过', () => {
    vi.useFakeTimers();
    const setup = setupRoom(3);
    manager.startGame(setup.sockets[0]!.id);
    // 先手出牌 → 回合转到下家
    const snap0 = lastEmit<GameSnapshot>(setup.sockets[0]!, SERVER_EVENTS.snapshot)!;
    const turn0 = snap0.turnPlayerId!;
    const idx0 = setup.ids.indexOf(turn0);
    const my0 = lastEmit<GameSnapshot>(setup.sockets[idx0]!, SERVER_EVENTS.snapshot)!;
    const combos0 = listPlayable(my0.players.find((p) => p.id === turn0)!.hand!, null, defaultRules);
    manager.play(setup.sockets[idx0]!.id, combos0[0]!.cards.map((c) => c.id));
    const turn1 = lastEmit<GameSnapshot>(setup.sockets[0]!, SERVER_EVENTS.snapshot)!.turnPlayerId!;
    expect(turn1).not.toBe(turn0);
    const idx1 = setup.ids.indexOf(turn1);
    // 掉线者的 socket 已被房间移除，之后收不到广播；改用始终在线的旁观 socket 读状态
    const observer = setup.sockets.find((_, i) => i !== idx1)!;
    // 轮到的人掉线
    manager.disconnect(setup.sockets[idx1]!.id);
    const st = lastEmit<RoomState>(observer, SERVER_EVENTS.roomUpdated)!;
    expect(st.players.find((p) => p.id === turn1)!.connected).toBe(false);
    // 错误 secret 重连被拒
    expect(() => manager.rejoin(setup.code, turn1, 'wrong-secret', mkSocket('s9'))).toThrow('身份校验失败');
    // 正确重连：恢复连接 + 立即收到快照
    const back = mkSocket('s9b');
    manager.rejoin(setup.code, turn1, setup.secrets[turn1]!, back);
    const st2 = lastEmit<RoomState>(observer, SERVER_EVENTS.roomUpdated)!;
    expect(st2.players.find((p) => p.id === turn1)!.connected).toBe(true);
    expect(lastEmit<GameSnapshot>(back, SERVER_EVENTS.snapshot)).toBeTruthy();
    // 再次掉线 → 超时自动过
    manager.disconnect(back.id);
    vi.advanceTimersByTime(30_001);
    expect(emittedEvents(observer).some((e) => e.type === 'passed' && e.playerId === turn1)).toBe(true);
    expect(lastEmit<GameSnapshot>(observer, SERVER_EVENTS.snapshot)!.turnPlayerId).not.toBe(turn1);
  });

  it('掉线起牌者：超时后自动出最小牌', () => {
    vi.useFakeTimers();
    // 用无干扰角色（避开冰封顺子冻结，2 人局会立即结束一轮）
    const sockets = [mkSocket('s0'), mkSocket('s1')];
    const { code, playerId } = manager.create('玩家1', sockets[0]!);
    const ids = [playerId];
    const secrets: Record<string, string> = { [playerId]: 'unused' };
    const r1 = manager.join(code, '玩家2', sockets[1]!);
    ids.push(r1.playerId);
    secrets[r1.playerId] = r1.secret;
    manager.selectRole(sockets[0]!.id, 'flashpoint');
    manager.selectRole(sockets[1]!.id, 'cs-champion');
    for (const s of sockets) manager.setReady(s.id, true);
    const setup = { sockets, ids, secrets, code };
    manager.startGame(setup.sockets[0]!.id);
    // 起牌者出单张（避免顺子触发冰封）→ 下家过 → 一轮结束，起牌者重新起牌
    const snap0 = lastEmit<GameSnapshot>(setup.sockets[0]!, SERVER_EVENTS.snapshot)!;
    const leaderId = snap0.roundLeaderId;
    const li = setup.ids.indexOf(leaderId);
    const myL = lastEmit<GameSnapshot>(setup.sockets[li]!, SERVER_EVENTS.snapshot)!;
    const combos = listPlayable(myL.players.find((p) => p.id === leaderId)!.hand!, null, defaultRules);
    const pick = combos.find((c) => c.type === 'single') ?? combos[0]!;
    manager.play(setup.sockets[li]!.id, pick.cards.map((c) => c.id));
    const mid = lastEmit<GameSnapshot>(setup.sockets[0]!, SERVER_EVENTS.snapshot)!;
    if (mid.turnPlayerId !== leaderId) {
      manager.pass(setup.sockets[setup.ids.indexOf(mid.turnPlayerId!)]!.id);
    }
    const snap1 = lastEmit<GameSnapshot>(setup.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap1.turnPlayerId).toBe(leaderId);
    expect(snap1.table).toBeNull();
    // 起牌者掉线 → 必须出牌 → 自动出最小组合
    manager.disconnect(setup.sockets[li]!.id);
    const observer = setup.sockets.find((_, i) => i !== li)!; // 掉线者收不到后续广播
    vi.advanceTimersByTime(30_001);
    expect(emittedEvents(observer).some((e) => e.type === 'cards:played' && e.playerId === leaderId)).toBe(true);
    const snap2 = lastEmit<GameSnapshot>(observer, SERVER_EVENTS.snapshot)!;
    expect(snap2.turnPlayerId).not.toBe(leaderId);
  });
});

describe('引擎异常安全网', () => {
  it('回答技能询问时引擎抛异常：本局安全终止、不向上抛出、全员可再来一局', () => {
    // 真实引擎外套 Proxy：resolveAsk 抛「翻牌池未清空」式守恒断言（模拟角色 bug）
    const registry: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
    const deck = buildDeck(3);
    const pick = (ids: number[]) => ids.map((id) => deck[id]!);
    const p0Hand = pick([0, 6, 7, 8, 9]);
    const p1Hand = pick([1, 2, 3, 54, 55]);
    const factory: RoomOptions['engineFactory'] = ({ players }) => {
      const real = new GameEngine(defaultRules, players, {
        rng: mulberry32(1),
        startPlayerId: players[0]!.id,
        roles: registry,
        scores: {},
        handsOverride: { [players[0]!.id]: p0Hand, [players[1]!.id]: p1Hand },
      });
      return new Proxy(real, {
        get(t, k) {
          if (k === 'resolveAsk') {
            return () => {
              throw new Error('翻牌池未清空（角色技能泄漏）');
            };
          }
          return Reflect.get(t, k);
        },
      });
    };
    const mgr = new RoomManager({
      roles: registry,
      scoreStore: new MemoryScoreStore(),
      autoPassMs: 30_000,
      engineFactory: factory,
    });
    const sockets = [mkSocket('s0'), mkSocket('s1')];
    const { code, playerId, secret } = mgr.create('房主', sockets[0]!);
    const ids = [playerId];
    const secrets: Record<string, string> = { [playerId]: secret };
    const r1 = mgr.join(code, '玩家2', sockets[1]!);
    ids.push(r1.playerId);
    secrets[r1.playerId] = r1.secret;
    mgr.selectRole(sockets[0]!.id, 'zecheng');
    mgr.selectRole(sockets[1]!.id, 'flashpoint');
    for (const s of sockets) mgr.setReady(s.id, true);
    // 打出一轮 → 观股确认询问
    mgr.startGame(sockets[0]!.id);
    const snap0 = lastEmit<GameSnapshot>(sockets[0]!, SERVER_EVENTS.snapshot)!;
    const hostHand = snap0.players.find((p) => p.id === ids[0])!.hand!;
    mgr.play(sockets[0]!.id, [hostHand.find((c) => c.rank === 3)!.id]);
    mgr.pass(sockets[1]!.id);
    const ask = lastEmit<SkillAsk>(sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('confirm');
    // 回答 → 引擎抛异常 → 安全网接住：不向外抛出、本局终止、不记分
    expect(() => mgr.useSkill(sockets[0]!.id, { askId: ask.askId!, choice: 'yes' })).not.toThrow();
    const st = lastEmit<RoomState>(sockets[0]!, SERVER_EVENTS.roomUpdated)!;
    expect(st.phase).toBe('finished');
    expect(st.winnerId).toBeNull();
    expect(st.scoreDeltas).toBeNull();
    // 全员可再来一局（房间没被带崩）
    mgr.rematch(sockets[0]!.id);
    mgr.rematch(sockets[1]!.id);
    const st2 = lastEmit<RoomState>(sockets[0]!, SERVER_EVENTS.roomUpdated)!;
    expect(st2.phase).toBe('lobby');
  });
});
