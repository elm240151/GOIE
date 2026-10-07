import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeck,
  clearRoles,
  defaultRules,
  GameEngine,
  isJoker,
  listPlayable,
  listRoles,
  mulberry32,
  SERVER_EVENTS,
  shuffle,
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
    const combos = listPlayable(me.hand!, mySnap.table, defaultRules, mySnap.orderReversed);
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

/** 固定手牌 3 人局（阿色专用）：
 *  房主（阿色）五张单3 先手；下家 4♥ 可压（extraValid 时还带第二张 4♥ 作补打）；
 *  第三家（hasFive 时带 5♥ 想压）。房主出单3 → 全过 → 轮末抽你询问（3 人局可发动 5 次）。 */
function mkCaptainSetup(opts: { extraValid?: boolean; hasFive?: boolean } = {}): {
  manager: RoomManager;
  sockets: FakeSocket[];
  ids: string[];
  secrets: Record<string, string>;
  code: string;
} {
  const registry: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
  const deck = buildDeck(3);
  const pick = (ids: number[]) => ids.map((id) => deck[id]!);
  const p0Hand = pick([0, 13, 26, 39, 54]); // 五张单3
  const p1Hand = pick(opts.extraValid ? [14, 68, 6, 7, 8] : [14, 6, 7, 8, 9]); // 4♥（+第二张4♥）9♠10♠J♠(Q♠)
  const p2Hand = pick(opts.hasFive ? [15, 19, 20, 21, 22] : [19, 20, 21, 22, 23]); // (5♥)9♥10♥J♥Q♥(K♥)
  const factory: RoomOptions['engineFactory'] = ({ players }) =>
    new GameEngine(defaultRules, players, {
      rng: mulberry32(1),
      startPlayerId: players[0]!.id,
      roles: registry,
      scores: {},
      handsOverride: { [players[0]!.id]: p0Hand, [players[1]!.id]: p1Hand, [players[2]!.id]: p2Hand },
    });
  const mgr = new RoomManager({
    roles: registry,
    scoreStore: new MemoryScoreStore(),
    autoPassMs: 30_000,
    engineFactory: factory,
  });
  const sockets = [mkSocket('s0'), mkSocket('s1'), mkSocket('s2')];
  const { code, playerId, secret } = mgr.create('房主', sockets[0]!);
  const ids = [playerId];
  const secrets: Record<string, string> = { [playerId]: secret };
  for (let i = 1; i < 3; i++) {
    const r = mgr.join(code, `玩家${i + 1}`, sockets[i]!);
    ids.push(r.playerId);
    secrets[r.playerId] = r.secret;
  }
  mgr.selectRole(sockets[0]!.id, 'captain');
  mgr.selectRole(sockets[1]!.id, 'flashpoint');
  mgr.selectRole(sockets[2]!.id, 'skywalker');
  for (const s of sockets) mgr.setReady(s.id, true);
  return { manager: mgr, sockets, ids, secrets, code };
}

/** 开局整备询问（先手阿色首回合抽你）：弃权，恢复出牌 */
function declineStartAsk(s: ReturnType<typeof mkCaptainSetup>): void {
  const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
  expect(ask.kind).toBe('confirm');
  expect(ask.prompt).toContain('5');
  s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'decline' });
  expect(lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!.pendingAsk).toBeNull();
}

/** 房主出单3 → 全员过 → 轮末抽你询问房主 */
function playToChouNiAsk(s: ReturnType<typeof mkCaptainSetup>): SkillAsk {
  s.manager.startGame(s.sockets[0]!.id);
  const snap0 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
  expect(snap0.turnPlayerId).toBe(s.ids[0]);
  declineStartAsk(s); // 开局整备弃权（首回合无摸牌但有整备阶段）
  const hostHand = snap0.players.find((p) => p.id === s.ids[0])!.hand!;
  s.manager.play(s.sockets[0]!.id, [hostHand.find((c) => c.rank === 3)!.id]);
  s.manager.pass(s.sockets[1]!.id);
  s.manager.pass(s.sockets[2]!.id);
  const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
  expect(mid.pendingAsk?.playerId).toBe(s.ids[0]);
  return lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
}

describe('技能询问（阿色）', () => {
  it('抽你：开局首回合整备询问直达先手，指定后首轮即生效', () => {
    const s = mkCaptainSetup({ hasFive: true });
    s.manager.startGame(s.sockets[0]!.id);
    // 开局即问先手阿色（首回合无摸牌但有整备阶段）
    const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('confirm');
    expect(ask.prompt).toContain('5');
    // 确认 → 选目标 p1
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'yes' });
    const pickAsk = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(pickAsk.kind).toBe('pickTarget');
    expect(pickAsk.targetCandidates).toEqual([s.ids[1], s.ids[2]]);
    s.manager.useSkill(s.sockets[0]!.id, { askId: pickAsk.askId!, targetPlayerId: s.ids[1] });
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    expect(after.turnPlayerId).toBe(s.ids[0]);
    expect(after.players.find((p) => p.id === s.ids[0])!.handCount).toBe(5); // 首回合无摸牌
    // 首轮：房主出单3 → p1 先过 → p2 想压5 被拦（抽你即时生效）
    const hostHand = after.players.find((p) => p.id === s.ids[0])!.hand!;
    s.manager.play(s.sockets[0]!.id, [hostHand.find((c) => c.rank === 3)!.id]);
    s.manager.pass(s.sockets[1]!.id);
    const p2Snap = lastEmit<GameSnapshot>(s.sockets[2]!, SERVER_EVENTS.snapshot)!;
    const five = p2Snap.players.find((p) => p.id === s.ids[2])!.hand!.find((c) => c.rank === 5)!;
    s.manager.play(s.sockets[2]!.id, [five.id]);
    expect(lastEmit<string>(s.sockets[2]!, SERVER_EVENTS.error)).toContain('抽你');
    // p2 过 → 全过轮末：牌权仍在房主 → 轮末抽你询问（还剩 4 次）
    s.manager.pass(s.sockets[2]!.id);
    const r2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(r2.pendingAsk?.playerId).toBe(s.ids[0]);
    expect(lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!.prompt).toContain('4');
  });

  it('抽你：确认→选目标（不含自己）→新轮只有指定者能响应', () => {
    const s = mkCaptainSetup({ hasFive: true });
    const ask = playToChouNiAsk(s);
    expect(ask.kind).toBe('confirm');
    expect(ask.prompt).toContain('5');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'yes' });
    const pickAsk = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(pickAsk.kind).toBe('pickTarget');
    expect(pickAsk.targetCandidates).toEqual([s.ids[1], s.ids[2]]);
    s.manager.useSkill(s.sockets[0]!.id, { askId: pickAsk.askId!, targetPlayerId: s.ids[1] });
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    expect(after.turnPlayerId).toBe(s.ids[0]);
    expect(after.players.find((p) => p.id === s.ids[0])!.handCount).toBe(5); // 4 + 补摸 1
    // 新轮：房主出单3 → p1 先过 → p2 想压5 被拦（只有 p1 能响应）→ p2 过 → 全过轮末
    const hostHand = after.players.find((p) => p.id === s.ids[0])!.hand!;
    s.manager.play(s.sockets[0]!.id, [hostHand.find((c) => c.rank === 3)!.id]);
    s.manager.pass(s.sockets[1]!.id);
    const p2Snap = lastEmit<GameSnapshot>(s.sockets[2]!, SERVER_EVENTS.snapshot)!;
    const five = p2Snap.players.find((p) => p.id === s.ids[2])!.hand!.find((c) => c.rank === 5)!;
    s.manager.play(s.sockets[2]!.id, [five.id]);
    expect(lastEmit<string>(s.sockets[2]!, SERVER_EVENTS.error)).toContain('抽你');
    s.manager.pass(s.sockets[2]!.id);
    const r2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(r2.pendingAsk?.playerId).toBe(s.ids[0]); // 牌权仍在房主，再次询问（还剩 4 次）
    expect(lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!.prompt).toContain('4');
  });

  it('再问：补打询问定向发给压牌者，补打的牌明置桌旁', () => {
    const s = mkCaptainSetup({ extraValid: true });
    s.manager.startGame(s.sockets[0]!.id);
    declineStartAsk(s);
    const snap0 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    const hostHand = snap0.players.find((p) => p.id === s.ids[0])!.hand!;
    s.manager.play(s.sockets[0]!.id, [hostHand.find((c) => c.rank === 3)!.id]);
    // p1 压 4♥ → 再问询问房主
    const p1Snap = lastEmit<GameSnapshot>(s.sockets[1]!, SERVER_EVENTS.snapshot)!;
    const four = p1Snap.players.find((p) => p.id === s.ids[1])!.hand!.find((c) => c.rank === 4)!;
    s.manager.play(s.sockets[1]!.id, [four.id]);
    const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid.pendingAsk?.playerId).toBe(s.ids[0]);
    const zw = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(zw.kind).toBe('confirm');
    s.manager.useSkill(s.sockets[0]!.id, { askId: zw.askId!, choice: 'yes' });
    // 补打询问发给压牌者 p1（askPlayerId 定向）
    const mid2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid2.pendingAsk?.playerId).toBe(s.ids[1]);
    const pickAsk = lastEmit<SkillAsk>(s.sockets[1]!, SERVER_EVENTS.skillAsk)!;
    expect(pickAsk.kind).toBe('pickCards');
    expect(pickAsk.askPlayerId).toBe(s.ids[1]);
    expect(pickAsk.cards).toHaveLength(1); // 只剩第二张 4♥
    s.manager.useSkill(s.sockets[1]!.id, { askId: pickAsk.askId!, cardIds: [pickAsk.cards![0]!.id] });
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    expect(after.tableSide).toHaveLength(1);
    expect(after.tableSide[0]!.rank).toBe(4);
    expect(after.players.find((p) => p.id === s.ids[1])!.handCount).toBe(3); // 5 - 压牌 - 补打
    // 全过 → 轮末 p1 补摸，桌面与边牌一起弃置
    s.manager.pass(s.sockets[2]!.id);
    s.manager.pass(s.sockets[0]!.id);
    const r2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(r2.players.find((p) => p.id === s.ids[1])!.handCount).toBe(4);
    expect(r2.table).toBeNull();
    expect(r2.tableSide).toHaveLength(0);
  });

  it('再问：打不出且超时 → 压牌归属改写为阿色，牌权归阿色', () => {
    vi.useFakeTimers();
    const s = mkCaptainSetup(); // 无第二张 4♥、无 5♥
    s.manager.startGame(s.sockets[0]!.id);
    declineStartAsk(s);
    const snap0 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    const hostHand = snap0.players.find((p) => p.id === s.ids[0])!.hand!;
    s.manager.play(s.sockets[0]!.id, [hostHand.find((c) => c.rank === 3)!.id]);
    const p1Snap = lastEmit<GameSnapshot>(s.sockets[1]!, SERVER_EVENTS.snapshot)!;
    const four = p1Snap.players.find((p) => p.id === s.ids[1])!.hand!.find((c) => c.rank === 4)!;
    s.manager.play(s.sockets[1]!.id, [four.id]);
    const zw = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    s.manager.useSkill(s.sockets[0]!.id, { askId: zw.askId!, choice: 'yes' });
    const pickAsk = lastEmit<SkillAsk>(s.sockets[1]!, SERVER_EVENTS.skillAsk)!;
    expect(pickAsk.cards).toHaveLength(0);
    vi.advanceTimersByTime(15_001); // 超时弃权 → 归属改写
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    expect(after.turnPlayerId).toBe(s.ids[1]); // 轮转从阿色下家继续
    expect(
      emittedEvents(s.sockets[0]!).some(
        (e) => e.type === 'table:attributed' && e.playerId === s.ids[0] && e.fromPlayerId === s.ids[1]
      )
    ).toBe(true);
    // 全过 → 牌权归阿色（轮末抽你询问）
    s.manager.pass(s.sockets[1]!.id);
    s.manager.pass(s.sockets[2]!.id);
    const r2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(r2.pendingAsk?.playerId).toBe(s.ids[0]);
    expect(lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!.prompt).toContain('5');
  });
});

/** 固定手牌 2 人局（海棠专用）：海棠（房主）不先手，下家先出。
 *  deck 下标（花色主序）：3♠=0 8♠=5 9♠=6 10♠=7 11♠=8 2♠=12 */
function mkFishySetup(handA: number[], handB: number[]): ReturnType<typeof mkCaptainSetup> {
  const registry: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
  const deck = buildDeck(3);
  const pick = (ids: number[]) => ids.map((id) => deck[id]!);
  const p0Hand = pick(handA);
  const p1Hand = pick(handB);
  const factory: RoomOptions['engineFactory'] = ({ players }) =>
    new GameEngine(defaultRules, players, {
      rng: mulberry32(1),
      startPlayerId: players[1]!.id,
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
  const r = mgr.join(code, '玩家2', sockets[1]!);
  ids.push(r.playerId);
  secrets[r.playerId] = r.secret;
  mgr.selectRole(sockets[0]!.id, 'fishy');
  mgr.selectRole(sockets[1]!.id, 'flashpoint');
  for (const s of sockets) mgr.setReady(s.id, true);
  return { manager: mgr, sockets, ids, secrets, code };
}

describe('技能询问（海棠）', () => {
  it('隐匿：整轮未出牌 → 轮末询问 → 选牌重铸 → 弃一摸一', () => {
    const s = mkFishySetup([6, 5], [0, 7]); // 海棠 [9♠,8♠]；下家 [3♠,10♠]
    s.manager.startGame(s.sockets[0]!.id);
    const snap0 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap0.turnPlayerId).toBe(s.ids[1]); // 下家先手
    expect(snap0.orderReversed).toBe(false);
    // 下家出 3♠ → 海棠过（9/8 压不了）→ 轮末隐匿询问直达海棠
    s.manager.play(s.sockets[1]!.id, [0]);
    s.manager.pass(s.sockets[0]!.id);
    const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid.pendingAsk?.playerId).toBe(s.ids[0]);
    const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('confirm');
    expect(ask.prompt).toContain('隐匿');
    // 确认 → 选牌（1-1 张）
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'yes' });
    const pickAsk = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(pickAsk.kind).toBe('pickCards');
    expect(pickAsk.cards!.map((c) => c.id).sort()).toEqual([5, 6]);
    // 弃 9♠ → 摸 1，轮末下家照常补摸
    s.manager.useSkill(s.sockets[0]!.id, { askId: pickAsk.askId!, cardIds: [6] });
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    expect(after.players.find((p) => p.id === s.ids[0])!.handCount).toBe(2); // 8♠ + 摸 1
    expect(after.discardCount).toBe(2); // 重铸弃 9♠ + 轮末桌面弃 3♠
    expect(after.deckCount).toBe(156); // 158 - 隐匿摸 1 - 补摸 1
    expect(after.turnPlayerId).toBe(s.ids[1]);
    expect(after.orderReversed).toBe(false);
  });

  it('隐匿：超时自动弃权，不重铸直接补摸', () => {
    vi.useFakeTimers();
    const s = mkFishySetup([6, 5], [0, 7]);
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[1]!.id, [0]);
    s.manager.pass(s.sockets[0]!.id);
    const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('confirm');
    vi.advanceTimersByTime(15_001); // 技能询问超时
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    expect(after.players.find((p) => p.id === s.ids[0])!.handCount).toBe(2);
    expect(after.discardCount).toBe(1); // 只有轮末桌面弃 3♠
    expect(after.deckCount).toBe(157);
  });

  it('洄游：出牌切换正↔倒随快照下发，轮末恢复正序', () => {
    const s = mkFishySetup([8, 6], [7, 12]); // 海棠 [11♠,9♠]；下家 [10♠,2♠]
    s.manager.startGame(s.sockets[0]!.id);
    // 下家出 10♠ → 海棠压 11♠（正序判定）→ 切倒序
    s.manager.play(s.sockets[1]!.id, [7]);
    s.manager.play(s.sockets[0]!.id, [8]);
    const snap = lastEmit<GameSnapshot>(s.sockets[1]!, SERVER_EVENTS.snapshot)!;
    expect(snap.orderReversed).toBe(true);
    expect(snap.table?.rank).toBe(11);
    // 下家 2♠ 倒序谁也压不了 → 过 → 轮末：海棠补摸（上一手是她）并起新轮，恢复正序
    s.manager.pass(s.sockets[1]!.id);
    const round2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(round2.orderReversed).toBe(false);
    expect(round2.turnPlayerId).toBe(s.ids[0]);
    // 海棠起 9♠ → 再切倒序
    s.manager.play(s.sockets[0]!.id, [6]);
    const snap2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap2.orderReversed).toBe(true);
  });
});

/** 固定手牌 2 人局（修勾专用）：修勾（房主），下家闪点。
 *  deck 下标（花色主序）：3♠=0 4♠=1 5♠=2 9♠=6 10♠=7 11♠=8 12♠=9 3♥=13 */
function mkDoggieSetup(handA: number[], handB: number[], startIdx = 0): ReturnType<typeof mkFixedSetup> {
  const registry: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
  const deck = buildDeck(3);
  const pick = (ids: number[]) => ids.map((id) => deck[id]!);
  const p0Hand = pick(handA);
  const p1Hand = pick(handB);
  const factory: RoomOptions['engineFactory'] = ({ players }) =>
    new GameEngine(defaultRules, players, {
      rng: mulberry32(1),
      startPlayerId: players[startIdx]!.id,
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
  const r = mgr.join(code, '玩家2', sockets[1]!);
  ids.push(r.playerId);
  secrets[r.playerId] = r.secret;
  mgr.selectRole(sockets[0]!.id, 'doggie');
  mgr.selectRole(sockets[1]!.id, 'flashpoint');
  for (const s of sockets) mgr.setReady(s.id, true);
  return { manager: mgr, sockets, ids, secrets, code };
}

describe('技能询问（修勾）', () => {
  it('答疑：下家出对3 → 询问直达修勾 → 改点 Q 随快照下发（牌面实体不变）', () => {
    const s = mkDoggieSetup([6, 7, 8, 9], [0, 13, 1], 1); // 修勾 [9♠10♠J♠Q♠]；下家 [3♠,3♥,4♠] 先手
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[1]!.id, [0, 13]); // 下家出对3（≥2 张）→ 答疑询问直达修勾
    const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid.pendingAsk?.playerId).toBe(s.ids[0]); // 询问的是修勾，不是出牌者
    const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('choice');
    expect(ask.prompt).toContain('答疑');
    // 改点 Q → 判定点数 12，牌面仍是 3♠3♥
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'Q' });
    const after = lastEmit<GameSnapshot>(s.sockets[1]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    expect(after.table?.rank).toBe(12);
    expect(after.table?.label).toBe('对Q'); // 牌型标签同步改点（客户端主显新点数）
    expect(after.tableRankNote).toEqual({ rank: 12 }); // 改点标注随快照广播给所有人
    expect(after.table?.cards.map((c) => c.id).sort()).toEqual([0, 13]);
  });

  it('狂吠：出牌后询问直达本人，连压 10→J→Q 打完获胜', () => {
    const s = mkDoggieSetup([6, 7, 8, 9], [0, 1, 2]); // 修勾 [9♠10♠J♠Q♠]；下家 [3♠4♠5♠]
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[0]!.id, [6]); // 修勾起单9 → 狂吠询问
    const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid.pendingAsk?.playerId).toBe(s.ids[0]);
    const ask1 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask1.kind).toBe('selfFollow');
    expect(ask1.prompt).toContain('狂吠');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask1.askId!, choice: 'yes', cardIds: [7] }); // 压 10♠
    const ask2 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask2.kind).toBe('selfFollow'); // 可连压：再问
    expect(ask2.askId).not.toBe(ask1.askId);
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask2.askId!, choice: 'yes', cardIds: [8] }); // 压 J♠
    const ask3 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask3.kind).toBe('selfFollow');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask3.askId!, choice: 'yes', cardIds: [9] }); // 压 Q♠ 打完
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.phase).toBe('finished');
    expect(after.winnerId).toBe(s.ids[0]);
  });

  it('狂吠：放弃 → 询问结束，轮到下家接牌', () => {
    const s = mkDoggieSetup([6, 7], [0, 1, 2]); // 修勾 [9♠10♠]；下家 [3♠4♠5♠]
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[0]!.id, [6]); // 起单9 → 狂吠询问
    const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('selfFollow');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'decline' });
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    expect(after.turnPlayerId).toBe(s.ids[1]); // 轮到下家
    expect(after.table?.rank).toBe(9); // 桌面保持修勾的单9
  });

  it('狂吠：非法选牌（对3压单9）→ 拒绝只发给本人并重新询问，对方收不到', () => {
    const s = mkDoggieSetup([6, 7, 13, 26], [0, 1, 2, 3, 4]); // 修勾 [9♠10♠3♥3♣]；下家 [3♠4♠5♠6♠7♠]
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[0]!.id, [6]); // 修勾起单9 → 狂吠询问
    const ask1 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask1.kind).toBe('selfFollow');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask1.askId!, choice: 'yes', cardIds: [13, 26] }); // 对3：合法牌型但压不过单9
    // 定向报错：只发给修勾本人（此前被静默丢弃，弹窗看似「点不了」）
    expect(lastEmit<string>(s.sockets[0]!, SERVER_EVENTS.error)).toBe('压不过自己的牌');
    expect(s.sockets[1]!.emit.mock.calls.every((c: unknown[]) => c[0] !== SERVER_EVENTS.error)).toBe(true);
    expect(emittedEvents(s.sockets[1]!).some((e) => e.type === 'game:error')).toBe(false);
    // 弹窗重新询问（新 askId），可继续正常选牌
    const ask2 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask2.kind).toBe('selfFollow');
    expect(ask2.askId).not.toBe(ask1.askId);
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask2.askId!, choice: 'yes', cardIds: [7] }); // 压 10♠
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.table?.rank).toBe(10);
    expect(after.turnPlayerId).toBe(s.ids[1]); // 剩余对3压不过单10 → 轮到下家
  });
});

/** 固定手牌 n 人局（橐驼专用）：房主 = 橐驼，其余 = 阿毛/首席蛋神（无被动干扰）。
 *  hands[i] 为各玩家基础牌（deck 下标）；fills[i] 为目标总张数（≤20），
 *  不足部分从 deck 下标 fillFrom 起往上填。牌堆顶 = 最大未用下标：
 *  填充总槽数恰好 = fillFrom..161 的张数时，顶 = fillFrom − 1
 *  （如 fillFrom=122 → 顶 = 121 = 第三副牌 ♥3，供地坛判定成功）。 */
function mkGuoSetup(
  hands: number[][],
  fills: number[],
  fillFrom: number,
  startIdx = 0,
  hostRole = 'guo-tt'
): { manager: RoomManager; sockets: FakeSocket[]; ids: string[]; secrets: Record<string, string>; code: string } {
  const registry: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
  const deck = buildDeck(3);
  const padded = hands.map((h) => [...h]);
  const used = new Set<number>(hands.flat());
  let next = fillFrom;
  for (let i = 0; i < padded.length; i++) {
    while (padded[i]!.length < fills[i]!) {
      while (used.has(next)) next++;
      padded[i]!.push(next);
      used.add(next);
    }
  }
  const cards = padded.map((h) => h.map((id) => deck[id]!));
  const factory: RoomOptions['engineFactory'] = ({ players }) =>
    new GameEngine(defaultRules, players, {
      rng: mulberry32(1),
      startPlayerId: players[startIdx]!.id,
      roles: registry,
      scores: {},
      handsOverride: Object.fromEntries(players.map((p, i) => [p.id, cards[i]!])),
    });
  const mgr = new RoomManager({
    roles: registry,
    scoreStore: new MemoryScoreStore(),
    autoPassMs: 30_000,
    engineFactory: factory,
  });
  const sockets = Array.from({ length: hands.length }, (_, i) => mkSocket(`s${i}`));
  const { code, playerId, secret } = mgr.create('房主', sockets[0]!);
  const ids = [playerId];
  const secrets: Record<string, string> = { [playerId]: secret };
  for (let i = 1; i < hands.length; i++) {
    const r = mgr.join(code, `玩家${i + 1}`, sockets[i]!);
    ids.push(r.playerId);
    secrets[r.playerId] = r.secret;
  }
  mgr.selectRole(sockets[0]!.id, hostRole);
  for (let i = 1; i < sockets.length; i++) mgr.selectRole(sockets[i]!.id, i % 2 === 1 ? 'flashpoint' : 'cs-champion');
  for (const s of sockets) mgr.setReady(s.id, true);
  return { manager: mgr, sockets, ids, secrets, code };
}

describe('技能询问（橐驼）', () => {
  it('地坛：下家出顺子 → 询问直达橐驼 → 判定成功诅咒广播 → 轮末取而代之摸牌起牌', () => {
    // 3 人局把牌堆顶推到第三副牌 ♥3（121）：橐驼 ♠345♠9；玩家2 ♥345♥6 先手出顺子
    const s = mkGuoSetup([[0, 1, 2, 6], [13, 14, 15, 16], [39]], [19, 20, 10], 122, 1);
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[1]!.id, [13, 14, 15]); // 玩家2 出 ♥345 → 地坛询问直达橐驼
    const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid.pendingAsk?.playerId).toBe(s.ids[0]); // 询问的是橐驼，不是出牌者
    const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('confirm');
    expect(ask.prompt).toContain('地坛');
    expect(ask.prompt).toContain('玩家2');
    // 同意 → 判定牌 ♥3 与顺子同花色 → 成功
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'yes' });
    expect(emittedEvents(s.sockets[0]!).some((e) => e.type === 'skill:triggered' && e.skillId === 'di-tan' && /成功/.test(e.text))).toBe(true);
    let snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.revealed).toHaveLength(0); // 判定牌已弃置
    expect(snap.cursedPlayerIds).toEqual([s.ids[1]]); // 诅咒已标记（含 pending，判定成功即广播）
    // 其余人全过 → 轮末玩家2 获牌权 → 橐驼取而代之（摸牌 + 起牌）
    s.manager.pass(s.sockets[2]!.id);
    s.manager.pass(s.sockets[0]!.id);
    expect(emittedEvents(s.sockets[1]!).some((e) => e.type === 'round:ended' && e.lastPlayerId === s.ids[1] && e.ledBy === s.ids[0] && e.drew === 1)).toBe(true);
    snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.turnPlayerId).toBe(s.ids[0]); // 橐驼起牌
    expect(snap.cursedPlayerIds).toEqual([s.ids[1]]); // 诅咒生效广播
    expect(snap.players.find((p) => p.id === s.ids[0])!.handCount).toBe(20); // 19 + 摸 1
    expect(snap.players.find((p) => p.id === s.ids[1])!.handCount).toBe(17); // 没摸（20 − 3）
    // 橐驼起单 9 → 玩家2 被禁自动过 → 轮到玩家3
    s.manager.play(s.sockets[0]!.id, [6]);
    snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.turnPlayerId).toBe(s.ids[2]);
  });

  it('地坛：弃权不消耗（下一轮再问）；判定翻到王 → 失败不诅咒', () => {
    const s = mkGuoSetup([[0, 1, 2], [13, 14, 15, 16, 17, 18, 19]], [3, 7], 80, 1); // 牌堆顶 = 大王
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[1]!.id, [13, 14, 15]); // ♥345 → 询问
    let ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.prompt).toContain('地坛');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'decline' }); // 弃权
    s.manager.pass(s.sockets[0]!.id); // 橐驼压不了 → 轮末玩家2 摸牌起牌
    // 下一轮再出顺子：弃权未消耗 → 仍询问；同意 → 翻到小王 → 失败
    s.manager.play(s.sockets[1]!.id, [16, 17, 18]); // ♥678
    ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.prompt).toContain('地坛');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'yes' });
    expect(emittedEvents(s.sockets[0]!).some((e) => e.type === 'skill:triggered' && e.skillId === 'di-tan' && /失败/.test(e.text))).toBe(true);
    const snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.cursedPlayerIds).toEqual([]); // 失败不诅咒
    expect(snap.revealed).toHaveLength(0); // 判定牌已弃置
  });

  it('诅咒单王：压单 2 → 桌面 singleJoker 广播 → 对方压不了 → 橐驼轮末起牌', () => {
    const s = mkGuoSetup([[52, 6], [12, 13]], [2, 2], 80, 1); // 橐驼 [小王,♠9]；玩家2 [♠2,♥3] 先手
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[1]!.id, [12]); // 玩家2 起单 2
    s.manager.play(s.sockets[0]!.id, [52]); // 橐驼单王压之
    const snap = lastEmit<GameSnapshot>(s.sockets[1]!, SERVER_EVENTS.snapshot)!; // 对手视角也看到
    expect(snap.table?.type).toBe('singleJoker');
    expect(snap.table?.label).toBe('王');
    expect(emittedEvents(s.sockets[1]!).some((e) => e.type === 'cards:played' && e.playerId === s.ids[0] && e.combo.type === 'singleJoker')).toBe(true);
    // 玩家2 无炸弹压不了 → 轮末橐驼摸牌起牌
    s.manager.pass(s.sockets[1]!.id);
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.turnPlayerId).toBe(s.ids[0]);
  });

  it('诅咒对王（2026-10-03）：桌面 jokerPair/对王 广播 → 对方对 2 压不了（报错）→ 全过轮末橐驼起牌', () => {
    const s = mkGuoSetup([[52, 53], [146, 159], []], [18, 20, 10], 113, 0); // 橐驼对王起手；玩家2 持 ♣2♦2
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[0]!.id, [52, 53]); // 橐驼起对王
    const snap = lastEmit<GameSnapshot>(s.sockets[1]!, SERVER_EVENTS.snapshot)!; // 对手视角
    expect(snap.table?.type).toBe('jokerPair');
    expect(snap.table?.label).toBe('对王');
    expect(emittedEvents(s.sockets[1]!).some((e) => e.type === 'cards:played' && e.playerId === s.ids[0] && e.combo.type === 'jokerPair')).toBe(true);
    // 玩家2 用对 2 压 → 只有炸弹能压对王 → 报错
    s.manager.play(s.sockets[1]!.id, [146, 159]);
    expect(lastEmit<string>(s.sockets[1]!, SERVER_EVENTS.error)).toContain('对王');
    // 全过 → 轮末橐驼摸牌起牌
    s.manager.pass(s.sockets[1]!.id);
    s.manager.pass(s.sockets[2]!.id);
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.turnPlayerId).toBe(s.ids[0]);
  });
});

describe('技能询问（楠王）', () => {
  it('旺旺亡语阻止获胜（打光手牌者判定摸 3 张）+ 回味压牌自动加牌广播', () => {
    // 3 人局：楠王 [♠9,♠J,大王]；玩家2 [♠10] 打光；牌堆顶 = 160 小王（非红桃）
    const s = mkGuoSetup([[6, 8, 161], [7], []], [5, 1, 5], 118, 0, 'king-nan');
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[0]!.id, [6]); // 楠王起单 ♠9
    s.manager.play(s.sockets[1]!.id, [7]); // 玩家2 ♠10 压（打光手牌）
    const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid.pendingAsk?.playerId).toBe(s.ids[0]); // 亡语：询问直达楠王，而非判玩家2获胜
    const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('confirm');
    expect(ask.prompt).toContain('旺旺');
    expect(ask.prompt).toContain('玩家2');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'yes' });
    expect(emittedEvents(s.sockets[1]!).some((e) => e.type === 'cards:revealed')).toBe(true); // 判定牌公开
    expect(emittedEvents(s.sockets[1]!).some((e) => e.type === 'skill:triggered' && e.skillId === 'wang-wang' && /成功/.test(e.text))).toBe(true);
    let snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.phase).toBe('playing'); // 无人获胜
    expect(snap.winnerId).toBeNull();
    expect(snap.players.find((p) => p.id === s.ids[1])!.handCount).toBe(3); // 成功班 +3
    expect(snap.revealed).toHaveLength(0); // 判定牌弃置
    // 玩家3 过 → 楠王 ♠J 压 ♠10 → 回味自动 +1（|J−10| = 1），不询问
    s.manager.pass(s.sockets[2]!.id);
    s.manager.play(s.sockets[0]!.id, [8]);
    expect(emittedEvents(s.sockets[1]!).some((e) => e.type === 'skill:triggered' && e.skillId === 'hui-wei' && /摸 1 张/.test(e.text))).toBe(true);
    snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.players.find((p) => p.id === s.ids[1])!.handCount).toBe(4); // 3 + 1
    expect(snap.pendingAsk).toBeNull(); // 回味锁定技不询问
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

/** 人机局（固定手牌或随机）：房主 = 真人，其余 = 人机（按 addBot 顺序） */
function mkBotSetup(opts: { hands?: number[][]; startIdx?: number; hostRole?: string; botCount?: number } = {}): {
  manager: RoomManager;
  sockets: FakeSocket[];
  hostId: string;
  botIds: string[];
  code: string;
} {
  const registry: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
  const deck = buildDeck(3);
  const factory: RoomOptions['engineFactory'] = ({ players, startPlayerId }) =>
    new GameEngine(defaultRules, players, {
      rng: mulberry32(42),
      startPlayerId: opts.startIdx != null ? players[opts.startIdx]!.id : startPlayerId,
      roles: registry,
      scores: {},
      handsOverride: opts.hands
        ? Object.fromEntries(players.map((p, i) => [p.id, opts.hands![i]!.map((id) => deck[id]!)]))
        : undefined,
    });
  const mgr = new RoomManager({
    roles: registry,
    scoreStore: new MemoryScoreStore(),
    autoPassMs: 30_000,
    botTurnMs: 100,
    botAskMs: 50,
    engineFactory: factory,
  });
  const sockets = [mkSocket('s0')];
  const { code, playerId: hostId } = mgr.create('房主', sockets[0]!);
  const botCount = opts.hands ? opts.hands.length - 1 : opts.botCount ?? 1;
  for (let i = 0; i < botCount; i++) mgr.addBot(sockets[0]!.id);
  mgr.selectRole(sockets[0]!.id, opts.hostRole ?? 'flashpoint');
  mgr.setReady(sockets[0]!.id, true);
  const st = lastEmit<RoomState>(sockets[0]!, SERVER_EVENTS.roomUpdated)!;
  const botIds = st.players.filter((p) => p.isBot).map((p) => p.id);
  return { manager: mgr, sockets, hostId, botIds, code };
}

/** 推进到终局：人机由定时器自动行动，真人出最小可出组合、技能询问弃权 */
function runBotGame(s: ReturnType<typeof mkBotSetup>): RoomState {
  let guard = 0;
  while (true) {
    if (++guard > 5000) throw new Error('人机局模拟未收敛');
    const st = lastEmit<RoomState>(s.sockets[0]!, SERVER_EVENTS.roomUpdated)!;
    if (st.phase === 'finished') return st;
    const snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    if (snap.pendingAsk) {
      const asked = snap.pendingAsk.playerId;
      if (s.botIds.includes(asked)) {
        vi.advanceTimersByTime(100); // 人机询问自动作答
      } else {
        s.manager.useSkill(s.sockets[0]!.id, { askId: snap.pendingAsk.askId, choice: 'decline' });
      }
      continue;
    }
    const turnId = snap.turnPlayerId!;
    if (s.botIds.includes(turnId)) {
      vi.advanceTimersByTime(200); // 人机自动出牌/过牌
      continue;
    }
    const me = snap.players.find((p) => p.id === turnId)!;
    const combos = listPlayable(me.hand!, snap.table, defaultRules, snap.orderReversed);
    if (combos.length === 0) {
      s.manager.pass(s.sockets[0]!.id);
      continue;
    }
    let moved = false;
    for (const combo of combos) {
      s.manager.play(s.sockets[0]!.id, combo.cards.map((c) => c.id));
      const s2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
      if (s2.pendingAsk || s2.turnPlayerId !== turnId) {
        moved = true;
        break;
      }
    }
    if (!moved) s.manager.pass(s.sockets[0]!.id);
  }
}

describe('人机系统', () => {
  it('大厅：房主逐次加入人机（白板自动准备），非房主/满员拒绝；可移除', () => {
    const host = mkSocket('s0');
    const { code } = manager.create('房主', host);
    const p1 = mkSocket('s1');
    manager.join(code, '玩家2', p1);
    expect(() => manager.addBot(p1.id)).toThrow('只有房主');
    manager.addBot(host.id);
    let st = lastEmit<RoomState>(host, SERVER_EVENTS.roomUpdated)!;
    expect(st.players).toHaveLength(3);
    const bot = st.players[2]!;
    expect(bot.isBot).toBe(true);
    expect(bot.name).toBe('人机 1');
    expect(bot.ready).toBe(true);
    expect(bot.roleId).toBe('');
    manager.addBot(host.id);
    st = lastEmit<RoomState>(host, SERVER_EVENTS.roomUpdated)!;
    expect(st.players[3]!.name).toBe('人机 2');
    manager.join(code, '玩家3', mkSocket('s2'));
    manager.join(code, '玩家4', mkSocket('s3'));
    expect(() => manager.addBot(host.id)).toThrow('房间已满');
    // 移除：非房主/非人机座位拒绝
    expect(() => manager.removeBot(p1.id, bot.id)).toThrow('只有房主');
    expect(() => manager.removeBot(host.id, st.players[0]!.id)).toThrow('只能移除人机');
    manager.removeBot(host.id, bot.id);
    st = lastEmit<RoomState>(host, SERVER_EVENTS.roomUpdated)!;
    expect(st.players.some((p) => p.id === bot.id)).toBe(false);
  });

  it('人机白板自动行动：先手人机起最小单张、能管就管、打光获胜', () => {
    vi.useFakeTimers();
    const s = mkBotSetup({ hands: [[1, 6], [0, 2]], startIdx: 1 }); // 房主 [♠4,♠9]；人机 [♠3,♠5] 先手
    s.manager.startGame(s.sockets[0]!.id);
    let snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.turnPlayerId).toBe(s.botIds[0]);
    vi.advanceTimersByTime(150); // 人机行动延迟
    snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.table?.rank).toBe(3); // 起最小单张 ♠3
    expect(snap.turnPlayerId).toBe(s.hostId);
    // 房主恰好大一级压 ♠4 → 人机 ♠5 管上并打光 → 获胜
    const hostHand = snap.players.find((p) => p.id === s.hostId)!.hand!;
    s.manager.play(s.sockets[0]!.id, [hostHand.find((c) => c.rank === 4)!.id]);
    snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.table?.rank).toBe(4);
    vi.advanceTimersByTime(150);
    snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.phase).toBe('finished');
    expect(snap.winnerId).toBe(s.botIds[0]);
  });

  it('人机管不了就过：轮末对方补摸起牌', () => {
    vi.useFakeTimers();
    const s = mkBotSetup({ hands: [[1, 5], [0, 3]], startIdx: 1 }); // 房主 [♠4,♠8]；人机 [♠3,♠6] 先手
    s.manager.startGame(s.sockets[0]!.id);
    vi.advanceTimersByTime(150); // 人机起 ♠3
    const snap0 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap0.table?.rank).toBe(3);
    // 房主恰好大一级压 ♠4 → 人机 ♠6 压不了 → 自动过 → 轮末房主补摸起牌
    s.manager.play(s.sockets[0]!.id, [1]);
    vi.advanceTimersByTime(150);
    const snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(emittedEvents(s.sockets[0]!).some((e) => e.type === 'passed' && e.playerId === s.botIds[0])).toBe(true);
    expect(snap.table).toBeNull();
    expect(snap.turnPlayerId).toBe(s.hostId);
    expect(snap.players.find((p) => p.id === s.hostId)!.handCount).toBe(2); // 1 + 补摸 1
  });

  it('人机被技能询问（观股大涨自选）：短延迟自动拿最小牌', () => {
    vi.useFakeTimers();
    // 房主（观股）[3♠,9♠,10♠,J♠,Q♠]；人机 [3♥,3♣,5♠,8♠,6♥] 无 4/2/炸弹压不了
    const s = mkBotSetup({ hands: [[0, 6, 7, 8, 9], [13, 26, 2, 5, 18]], hostRole: 'zecheng' });
    s.manager.startGame(s.sockets[0]!.id);
    s.manager.play(s.sockets[0]!.id, [0]); // 房主出单3 → 人机自动过 → 轮末观股询问房主
    vi.advanceTimersByTime(150);
    const mid = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid.pendingAsk?.playerId).toBe(s.hostId);
    const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('confirm');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, choice: 'yes' });
    // 大涨自选：先问房主 → 再问人机（无 socket，短延迟自动作答）
    const ask1 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask1.kind).toBe('pickCards');
    s.manager.useSkill(s.sockets[0]!.id, { askId: ask1.askId!, cardIds: [ask1.cards![0]!.id] });
    const mid2 = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(mid2.pendingAsk?.playerId).toBe(s.botIds[0]);
    vi.advanceTimersByTime(100); // 人机询问延迟 50ms → 自动拿最小
    const after = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(after.pendingAsk).toBeNull();
    expect(after.players.find((p) => p.id === s.hostId)!.handCount).toBe(5); // 4 + 大涨 1
    expect(after.players.find((p) => p.id === s.botIds[0])!.handCount).toBe(6); // 5 + 大涨 1
    expect(after.deckCount).toBe(147); // 162 − 发牌 10 − 亮 5
  });

  it('对局中不能加入/移除人机', () => {
    vi.useFakeTimers();
    const s = mkBotSetup({ hands: [[3, 4], [0, 7]], startIdx: 1 });
    s.manager.startGame(s.sockets[0]!.id);
    expect(() => s.manager.addBot(s.sockets[0]!.id)).toThrow('游戏已开始');
    expect(() => s.manager.removeBot(s.sockets[0]!.id, s.botIds[0]!)).toThrow('游戏中不能移除人机');
  });

  it('整局模拟：人机自动打完随机局，战绩落盘、再来一局人机自动投票', async () => {
    vi.useFakeTimers();
    const s = mkBotSetup({ botCount: 2 }); // 1 真人 + 2 人机，随机手牌
    s.manager.startGame(s.sockets[0]!.id);
    let st = runBotGame(s);
    for (let draws = 0; !st.winnerId && draws < 5; draws++) {
      // 极小概率流局：人机自动投票回房间再来
      s.manager.rematch(s.sockets[0]!.id);
      s.manager.setReady(s.sockets[0]!.id, true);
      s.manager.startGame(s.sockets[0]!.id);
      st = runBotGame(s);
    }
    expect(st.phase).toBe('finished');
    expect(st.winnerId).toBeTruthy();
    const deltas = st.scoreDeltas!;
    expect([s.hostId, ...s.botIds].reduce((sum, id) => sum + deltas[id]!, 0)).toBe(0); // 零和
    // 战绩落盘含人机
    const records = await s.manager.listScores();
    const last = records[records.length - 1]!;
    expect(last.players).toHaveLength(3);
    expect(last.players.some((p) => p.name.startsWith('人机'))).toBe(true);
    // 再来一局：人机自动投票 → 房主一票即回房间；人机保持自动准备，可直接开局
    s.manager.rematch(s.sockets[0]!.id);
    const st2 = lastEmit<RoomState>(s.sockets[0]!, SERVER_EVENTS.roomUpdated)!;
    expect(st2.phase).toBe('lobby');
    expect(st2.players.filter((p) => p.isBot).every((p) => p.ready)).toBe(true);
    expect(st2.players.find((p) => p.id === s.hostId)!.ready).toBe(false);
    s.manager.setReady(s.sockets[0]!.id, true);
    s.manager.startGame(s.sockets[0]!.id);
    const snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.roundLeaderId).toBe(st.winnerId); // 先手给上局赢家（可能是人机 → 自动行动）
  });
});

describe('私密事件路由（窃笑）', () => {
  it('skill:peek 只发查看者、skill:peeked 只发被查看者，其余玩家两者都不收', () => {
    const s = setupRoom(3);
    manager.selectRole(s.sockets[0]!.id, 'button'); // 玩家1 改选轴承
    manager.startGame(s.sockets[0]!.id); // 房主先手 → 玩家1 的回合

    // 主动技窃笑 → pickTarget 询问
    manager.useSkill(s.sockets[0]!.id, { skillId: 'qie-xiao' });
    const ask = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask.kind).toBe('pickTarget');
    expect(ask.targetCandidates).toEqual([s.ids[1], s.ids[2]]);

    // 查看玩家2 的手牌
    manager.useSkill(s.sockets[0]!.id, { askId: ask.askId!, targetPlayerId: s.ids[1] });

    const e0 = emittedEvents(s.sockets[0]!);
    const e1 = emittedEvents(s.sockets[1]!);
    const e2 = emittedEvents(s.sockets[2]!);
    const peek0 = e0.find((e) => e.type === 'skill:peek');
    expect(peek0).toBeDefined();
    if (peek0 && peek0.type === 'skill:peek') {
      expect(peek0.viewerId).toBe(s.ids[0]);
      expect(peek0.targetId).toBe(s.ids[1]);
      expect(peek0.cards.length).toBeGreaterThan(0); // 携带被查看者完整手牌
    }
    expect(e0.some((e) => e.type === 'skill:peeked')).toBe(false); // 查看者不收提示
    expect(e1.some((e) => e.type === 'skill:peek')).toBe(false); // 被查看者不收手牌
    expect(e1.some((e) => e.type === 'skill:peeked')).toBe(true); // 被查看者收到提示
    expect(e2.some((e) => e.type === 'skill:peek' || e.type === 'skill:peeked')).toBe(false); // 旁人完全不知
  });
});

describe('自定义摸牌（Elm 开发者账号）', () => {
  /** 2 人局：房主名 Elm + 固定种子真实发牌（devSwap 依赖 rawDraw 记录，不能用 handsOverride） */
  function mkElmSetup(): { mgr: RoomManager; sockets: FakeSocket[]; ids: string[]; secrets: Record<string, string>; code: string } {
    const registry: RoleRegistry = new Map(listRoles().map((r) => [r.id, r]));
    const factory: RoomOptions['engineFactory'] = ({ players, startPlayerId, devDrawPlayerIds }) =>
      new GameEngine(defaultRules, players, {
        rng: mulberry32(7),
        startPlayerId,
        roles: registry,
        scores: {},
        devDrawPlayerIds,
      });
    const mgr = new RoomManager({
      roles: registry,
      scoreStore: new MemoryScoreStore(),
      autoPassMs: 30_000,
      engineFactory: factory,
    });
    const sockets = [mkSocket('s0'), mkSocket('s1')];
    const { code, playerId, secret } = mgr.create('Elm', sockets[0]!);
    const ids = [playerId];
    const secrets: Record<string, string> = { [playerId]: secret };
    const r1 = mgr.join(code, '玩家2', sockets[1]!);
    ids.push(r1.playerId);
    secrets[r1.playerId] = r1.secret;
    mgr.selectRole(sockets[0]!.id, 'skywalker');
    mgr.selectRole(sockets[1]!.id, 'elm-yao');
    mgr.setReady(sockets[0]!.id, true);
    mgr.setReady(sockets[1]!.id, true);
    return { mgr, sockets, ids, secrets, code };
  }

  it('仅 Elm 座位可开开关；房态广播 isDev/devDraw', () => {
    const s = setupRoom(2);
    // 普通玩家开开关被拒
    expect(() => manager.setDevDraw(s.sockets[1]!.id, true)).toThrow('仅开发者账号');
    const st = lastEmit<RoomState>(s.sockets[0]!, SERVER_EVENTS.roomUpdated)!;
    for (const p of st.players) expect(p.isDev).toBe(false);

    const elm = mkElmSetup();
    const st0 = lastEmit<RoomState>(elm.sockets[0]!, SERVER_EVENTS.roomUpdated)!;
    const me0 = st0.players.find((p) => p.name === 'Elm')!;
    expect(me0.isDev).toBe(true);
    expect(me0.devDraw).toBe(false);
    elm.mgr.setDevDraw(elm.sockets[0]!.id, true);
    const st1 = lastEmit<RoomState>(elm.sockets[0]!, SERVER_EVENTS.roomUpdated)!;
    expect(st1.players.find((p) => p.name === 'Elm')!.devDraw).toBe(true);
  });

  it('Elm 开局逐张换牌询问链：换牌生效播报、restKeep 收尾开局', () => {
    const s = mkElmSetup();
    s.mgr.setDevDraw(s.sockets[0]!.id, true);
    s.mgr.startGame(s.sockets[0]!.id);
    // 发牌期挂起：先手 6 张逐张询问（种子 7 牌堆可复算，牌堆尾 6 张 = 发牌序）
    const deck = shuffle(buildDeck(3), mulberry32(7));
    const p0Drawn = deck.slice(156);
    const ask1 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask1.kind).toBe('devSwap');
    expect(ask1.swapTotal).toBe(6);
    expect(ask1.swapIndex).toBe(0);
    expect(ask1.cards![0]!.id).toBe(p0Drawn[0]!.id);
    // 换成牌堆底那张（必在牌堆中——发牌只摸了尾 11 张）
    const target = deck[0]!;
    const spec = isJoker(target) ? { joker: target.rank } : { suit: target.suit, rank: target.rank };
    s.mgr.useSkill(s.sockets[0]!.id, { askId: ask1.askId, swapSpec: spec });
    // 下一张挂起
    const ask2 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask2.kind).toBe('devSwap');
    expect(ask2.swapIndex).toBe(1);
    expect(ask2.cards![0]!.id).toBe(p0Drawn[1]!.id);
    // 换牌播报（skill:triggered roleId=dev 广播）
    const evs = emittedEvents(s.sockets[0]!);
    expect(evs.some((e) => e.type === 'skill:triggered' && e.playerId === s.ids[0])).toBe(true);
    // 剩余全部保持 → 开局
    s.mgr.useSkill(s.sockets[0]!.id, { askId: ask2.askId, choice: 'restKeep' });
    const snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.phase).toBe('playing');
    expect(snap.pendingAsk).toBeNull();
    const me = snap.players.find((p) => p.id === s.ids[0]!)!;
    expect(me.hand!.some((c) => c.id === target.id)).toBe(true);
    expect(me.hand!.some((c) => c.id === p0Drawn[0]!.id)).toBe(false);
    // 守恒：6 + 5 + 151 = 162
    expect(me.hand!.length + snap.players[1]!.handCount + snap.deckCount).toBe(162);
  });

  it('换牌询问超时自动保持：60 秒逐张保持完 6 张后正常开局', async () => {
    vi.useFakeTimers();
    const s = mkElmSetup();
    s.mgr.setDevDraw(s.sockets[0]!.id, true);
    s.mgr.startGame(s.sockets[0]!.id);
    const ask1 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask1.kind).toBe('devSwap');
    // 超时 60s → 保持第 1 张 → 自动推进第 2 张
    await vi.advanceTimersByTimeAsync(60_000);
    const ask2 = lastEmit<SkillAsk>(s.sockets[0]!, SERVER_EVENTS.skillAsk)!;
    expect(ask2.kind).toBe('devSwap');
    expect(ask2.swapIndex).toBe(1);
    // 剩余 5 张全部超时 → 全部保持 → 开局
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(60_000);
    const snap = lastEmit<GameSnapshot>(s.sockets[0]!, SERVER_EVENTS.snapshot)!;
    expect(snap.phase).toBe('playing');
    expect(snap.pendingAsk).toBeNull();
    const me = snap.players.find((p) => p.id === s.ids[0]!)!;
    expect(me.handCount).toBe(6); // 全部保持：原始发牌 6 张
    // 全程无换牌播报
    const evs = emittedEvents(s.sockets[0]!);
    expect(evs.some((e) => e.type === 'skill:triggered' && e.playerId === s.ids[0])).toBe(false);
    vi.useRealTimers();
  });
});
