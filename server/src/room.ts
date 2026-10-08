// 房间：座位/角色选择/准备/开局/rematch/掉线自动过/技能询问/事件广播。
// 服务端权威：所有游戏动作走 shared 的 GameEngine，结果以事件 + 按人过滤的快照广播。
import { randomUUID } from 'node:crypto';
import {
  defaultRules,
  GameEngine,
  listPlayable,
  mulberry32,
  SERVER_EVENTS,
  type ActionResult,
  type EnginePlayer,
  type GameEvent,
  type RoleRegistry,
  type RoomState,
  type SkillAsk,
  type SkillUsePayload,
} from '@gdys/shared';
import { autoPlayFallback, generatePlayerSecret } from './reconnect';
import type { ScoreStore } from './scoreStore';

/** 房间对 socket 的最小依赖（Socket.IO 的 Socket 结构上满足；测试用假 socket） */
export interface RoomSocket {
  id: string;
  emit(ev: string, payload: unknown): unknown;
}

/** 自定义摸牌开发者名单：这些名字进房即开发者（可开关自定义摸牌；2026-10-08 用户要求加「挂哥」） */
export const DEV_NAMES = ['Elm', '挂哥'];

interface Seat {
  id: string;
  name: string;
  roleId: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  /** 人机：无 socket、无角色、自动行动（测试注入时缩小延迟） */
  isBot: boolean;
  /** 自定义摸牌开关（仅开发者账号 Elm / 挂哥 可切） */
  devDraw: boolean;
  secret: string;
  socketId: string | null;
}

export interface RoomOptions {
  code: string;
  roles: RoleRegistry;
  scoreStore: ScoreStore;
  autoPassMs: number;
  /** 人机出牌/过牌延迟（毫秒，缺省 800） */
  botTurnMs?: number;
  /** 人机被技能询问时的自动作答延迟（毫秒，缺省 400） */
  botAskMs?: number;
  /** 测试注入：自定义引擎（如指定手牌）；不传则正常随机发牌 */
  engineFactory?: (opts: {
    players: EnginePlayer[];
    startPlayerId: string;
    scores: Record<string, number>;
    devDrawPlayerIds: string[];
  }) => GameEngine;
}

export class Room {
  readonly code: string;
  phase: 'lobby' | 'playing' | 'finished' = 'lobby';
  private hostId = '';
  private readonly seats: Seat[] = [];
  private readonly sockets = new Map<string, RoomSocket>();
  private readonly roles: RoleRegistry;
  private readonly scoreStore: ScoreStore;
  private readonly autoPassMs: number;
  private readonly botTurnMs: number;
  private readonly botAskMs: number;
  private readonly engineFactory: RoomOptions['engineFactory'];
  private engine: GameEngine | null = null;
  private totals: Record<string, number> = {};
  private lastWinnerId: string | null = null;
  private lastDeltas: Record<string, number> | null = null;
  private rematchVotes = new Set<string>();
  private autoPassTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private askTimer: ReturnType<typeof setTimeout> | null = null;
  private botTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RoomOptions) {
    this.code = opts.code;
    this.roles = opts.roles;
    this.scoreStore = opts.scoreStore;
    this.autoPassMs = opts.autoPassMs;
    this.botTurnMs = opts.botTurnMs ?? 800;
    this.botAskMs = opts.botAskMs ?? 400;
    this.engineFactory = opts.engineFactory;
  }

  get playerCount(): number {
    return this.seats.length;
  }

  state(): RoomState {
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      players: this.seats.map((s) => ({
        id: s.id,
        name: s.name,
        roleId: s.roleId,
        ready: s.ready,
        connected: s.connected,
        isHost: s.isHost,
        isBot: s.isBot,
        isDev: DEV_NAMES.includes(s.name),
        devDraw: s.devDraw,
      })),
      winnerId: this.lastWinnerId,
      scoreDeltas: this.lastDeltas,
      totals: { ...this.totals },
      rematchVotes: [...this.rematchVotes],
    };
  }

  // ---------- 大厅 ----------

  addPlayer(name: string, socket: RoomSocket, isHost: boolean): { playerId: string; secret: string } {
    name = name.trim();
    if (!name || name.length > 12) throw new Error('名字需为 1-12 个字符');
    if (this.phase !== 'lobby') throw new Error('游戏已开始，无法加入');
    if (this.seats.length >= 6) throw new Error('房间已满（最多 6 人）');
    if (this.seats.some((s) => s.name === name)) throw new Error('名字已被使用');
    const playerId = randomUUID();
    const secret = generatePlayerSecret();
    this.seats.push({
      id: playerId,
      name,
      roleId: '',
      ready: false,
      connected: true,
      isHost,
      isBot: false,
      devDraw: false,
      secret,
      socketId: socket.id,
    });
    this.sockets.set(playerId, socket);
    if (isHost) this.hostId = playerId;
    return { playerId, secret };
  }

  /** 房主加人机：按一次加一个；白板（无角色、自动准备），无 socket 由房间自动驱动 */
  addBot(playerId: string): void {
    if (this.phase !== 'lobby') throw new Error('游戏已开始，无法加入人机');
    if (playerId !== this.hostId) throw new Error('只有房主可以加入人机');
    if (this.seats.length >= 6) throw new Error('房间已满（最多 6 人）');
    let maxN = 0;
    for (const s of this.seats) {
      const m = s.isBot ? /^人机 (\d+)$/.exec(s.name) : null;
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    this.seats.push({
      id: randomUUID(),
      name: `人机 ${maxN + 1}`,
      roleId: '',
      ready: true,
      connected: true,
      isHost: false,
      isBot: true,
      devDraw: false,
      secret: generatePlayerSecret(),
      socketId: null,
    });
    this.broadcastState();
  }

  /** 房主移除指定人机（仅大厅） */
  removeBot(playerId: string, botId: string): void {
    if (this.phase !== 'lobby') throw new Error('游戏中不能移除人机');
    if (playerId !== this.hostId) throw new Error('只有房主可以移除人机');
    const seat = this.seats.find((s) => s.id === botId);
    if (!seat) throw new Error('该座位不存在');
    if (!seat.isBot) throw new Error('只能移除人机座位');
    this.seats.splice(this.seats.indexOf(seat), 1);
    this.broadcastState();
  }

  /** 开发者账号（Elm / 挂哥）开关自定义摸牌：大厅或游戏中均可切 */
  setDevDraw(playerId: string, enabled: boolean): void {
    const seat = this.seats.find((s) => s.id === playerId);
    if (!seat) throw new Error('该座位不存在');
    if (!DEV_NAMES.includes(seat.name)) throw new Error('仅开发者账号（Elm / 挂哥）可用');
    seat.devDraw = enabled;
    if (this.engine) {
      this.engine.setDevDraw(playerId, enabled);
      // 关闭时若换牌询问正挂起：引擎已清挂起，把滞留事件与最新快照广播出去
      this.dispatchEvents(this.engine.drainEvents());
      this.syncSnapshots();
    }
    this.broadcastState();
  }

  rejoin(playerId: string, secret: string, socket: RoomSocket): void {
    const seat = this.seats.find((s) => s.id === playerId);
    if (!seat) throw new Error('该房间没有这个座位');
    if (seat.secret !== secret) throw new Error('身份校验失败');
    seat.socketId = socket.id;
    seat.connected = true;
    this.cancelAutoPass(playerId);
    this.sockets.set(playerId, socket);
    this.broadcastState();
    if (this.engine) {
      socket.emit(SERVER_EVENTS.snapshot, this.engine.snapshotFor(playerId));
      // 重连时把未决的技能询问重新发给被询问者
      const ask = this.engine.currentAsk(playerId);
      if (ask) socket.emit(SERVER_EVENTS.skillAsk, ask);
    }
  }

  selectRole(playerId: string, roleId: string): void {
    if (this.phase !== 'lobby') throw new Error('游戏中不能更换角色');
    const seat = this.seatOf(playerId);
    const role = this.roles.get(roleId);
    if (!role) throw new Error('角色不存在');
    const taken = this.seats.filter((s) => s.roleId === roleId && s.id !== playerId).length;
    if (taken >= (role.maxPerRoom ?? 1)) throw new Error('该角色已被别人选择');
    seat.roleId = roleId;
    this.broadcastState();
  }

  setReady(playerId: string, ready: boolean): void {
    if (this.phase !== 'lobby') throw new Error('当前不能更改准备状态');
    this.seatOf(playerId).ready = ready;
    this.broadcastState();
  }

  /** 房主开局：全员连接、选好角色、准备完毕 */
  startGame(hostId: string): void {
    if (this.phase !== 'lobby') throw new Error('游戏已在进行中');
    if (hostId !== this.hostId) throw new Error('只有房主可以开始游戏');
    if (this.seats.length < 2) throw new Error('至少需要 2 名玩家');
    if (!this.seats.every((s) => s.connected)) throw new Error('有玩家掉线，无法开始');
    if (!this.seats.every((s) => s.roleId || s.isBot)) throw new Error('还有玩家未选角色');
    if (!this.seats.every((s) => s.ready)) throw new Error('还有玩家未准备');
    for (const s of this.seats) {
      if (!s.isBot && !this.roles.has(s.roleId)) throw new Error('存在未注册的角色');
    }
    // 先手：上局赢家；首局房主
    const startPlayerId =
      this.lastWinnerId && this.seats.some((s) => s.id === this.lastWinnerId)
        ? this.lastWinnerId
        : this.hostId;
    const players = this.seats.map((s) => ({ id: s.id, name: s.name, roleId: s.roleId }));
    // 自定义摸牌（开发者）：开局前已开开关的座位 → 引擎开局即问初始手牌换牌
    const devDrawPlayerIds = this.seats.filter((s) => s.devDraw).map((s) => s.id);
    this.engine = this.engineFactory
      ? this.engineFactory({ players, startPlayerId, scores: this.totals, devDrawPlayerIds })
      : new GameEngine(defaultRules, players, {
          rng: mulberry32(Math.floor(Math.random() * 2 ** 31)),
          startPlayerId,
          roles: this.roles,
          scores: this.totals,
          devDrawPlayerIds,
        });
    this.phase = 'playing';
    this.engine.start();
    this.dispatchEvents(this.engine.drainEvents());
    this.syncSnapshots();
    this.handlePendingAsk(); // 开局整备询问（如阿色首回合抽你）：直达被询问者 + 超时定时器
    this.scheduleBotTurn(); // 先手是人机（如上局赢家）→ 自动行动
    this.broadcastState();
  }

  // ---------- 对局 ----------

  play(playerId: string, cardIds: number[], flippedCardId?: number): void {
    const engine = this.requireEngine(); // 大厅/终局动作照常抛「游戏不在进行中」
    let r: ActionResult;
    try {
      r = engine.playCards(playerId, cardIds, flippedCardId);
    } catch (e) {
      this.abortGame(e);
      return;
    }
    if (!r.ok) {
      this.sendTo(playerId, SERVER_EVENTS.error, r.reason);
      return;
    }
    this.afterAction(r);
  }

  pass(playerId: string): void {
    const engine = this.requireEngine();
    let r: ActionResult;
    try {
      r = engine.pass(playerId);
    } catch (e) {
      this.abortGame(e);
      return;
    }
    if (!r.ok) {
      this.sendTo(playerId, SERVER_EVENTS.error, r.reason);
      return;
    }
    this.afterAction(r);
  }

  /** 主动技（无 askId）或回答技能询问（有 askId） */
  useSkill(playerId: string, req: SkillUsePayload): void {
    const engine = this.requireEngine();
    let r: ActionResult;
    try {
      r = req.askId
        ? engine.resolveAsk(playerId, {
            askId: req.askId,
            choice: req.choice,
            cardIds: req.cardIds,
            targetPlayerId: req.targetPlayerId,
            guess: req.guess,
            swapSpec: req.swapSpec,
          })
        : engine.useSkillAction(playerId, { skillId: req.skillId ?? '' });
    } catch (e) {
      this.abortGame(e);
      return;
    }
    if (!r.ok) {
      this.sendTo(playerId, SERVER_EVENTS.error, r.reason);
      return;
    }
    this.cancelAskTimer();
    this.afterAction(r);
  }

  rematch(playerId: string): void {
    if (this.phase !== 'finished') throw new Error('当前不能发起再来一局');
    this.rematchVotes.add(playerId);
    // 人机自动同意再来一局
    for (const s of this.seats) if (s.isBot) this.rematchVotes.add(s.id);
    this.broadcastState();
    // 全员投票 → 回到房间，可重新选角色、重新准备（房主开局；先手仍给上局赢家）
    if (this.rematchVotes.size >= this.seats.length) {
      this.rematchVotes.clear();
      this.phase = 'lobby';
      this.engine = null;
      for (const s of this.seats) if (!s.isBot) s.ready = false; // 人机保持自动准备
      this.broadcastState();
    }
  }

  leave(socketId: string): void {
    const seat = this.seats.find((s) => s.socketId === socketId);
    if (!seat) return;
    if (this.phase !== 'lobby') {
      // 对局中离开按掉线处理：座位保留，可随时重连回来
      this.onSocketDisconnect(socketId);
      return;
    }
    this.sockets.delete(seat.id);
    this.rematchVotes.delete(seat.id);
    this.seats.splice(this.seats.indexOf(seat), 1);
    if (this.hostId === seat.id) {
      const next = this.seats.find((s) => !s.isBot); // 房主让位跳过人机
      if (next) {
        next.isHost = true;
        this.hostId = next.id;
      }
    }
    // 只剩人机：清空座位，房间随人数归零被回收
    if (!this.seats.some((s) => !s.isBot)) this.seats.splice(0, this.seats.length);
    this.broadcastState();
  }

  onSocketDisconnect(socketId: string): void {
    const seat = this.seats.find((s) => s.socketId === socketId);
    if (!seat) return;
    seat.socketId = null;
    seat.connected = false;
    this.sockets.delete(seat.id);
    // 轮到掉线者 → 超时自动过（起牌者自动出最小牌）
    if (this.phase === 'playing' && this.engine) {
      const turnId = this.engine.snapshotFor(this.seats[0]!.id).turnPlayerId;
      if (turnId === seat.id) this.scheduleAutoPass(seat.id);
    }
    this.broadcastState();
  }

  clearTimers(): void {
    for (const t of this.autoPassTimers.values()) clearTimeout(t);
    this.autoPassTimers.clear();
    this.cancelAskTimer();
    this.cancelBotTurn();
  }

  // ---------- 内部 ----------

  private seatOf(playerId: string): Seat {
    const seat = this.seats.find((s) => s.id === playerId);
    if (!seat) throw new Error('你不是这个房间的成员');
    return seat;
  }

  private requireEngine(): GameEngine {
    if (!this.engine || this.phase !== 'playing') throw new Error('游戏不在进行中');
    return this.engine;
  }

  /** 引擎异常安全网：本局终止并通知全员，绝不让角色 bug 杀死服务器进程 */
  private abortGame(e: unknown): void {
    console.error(`[房间 ${this.code}] 引擎异常，本局终止:`, e);
    if (this.phase !== 'playing') return;
    this.cancelAskTimer();
    for (const t of this.autoPassTimers.values()) clearTimeout(t);
    this.autoPassTimers.clear();
    this.phase = 'finished';
    this.lastWinnerId = null;
    this.lastDeltas = null;
    this.broadcast(SERVER_EVENTS.error, '牌局出现异常，本局已终止');
    this.broadcastState();
  }

  private afterAction(r: ActionResult): void {
    if (!r.ok) return;
    this.dispatchEvents(r.events);
    this.syncSnapshots();
    this.handlePendingAsk();
    this.scheduleBotTurn();
    // 终局判定看引擎真实 phase：dealing 期（如开发者自定义摸牌逐张询问中）快照会报 finished，不能误判终局
    if (this.engine!.isFinished) void this.onFinished();
  }

  /** 动作后出现技能询问：把完整询问发给被询问者并启动超时自动弃权 */
  private handlePendingAsk(): void {
    this.cancelAskTimer();
    const engine = this.engine;
    if (!engine || this.phase !== 'playing') return;
    const askedId = engine.pendingAskPlayerId;
    if (!askedId) return;
    const ask = engine.currentAsk(askedId);
    if (!ask) return;
    this.sendTo(askedId, SERVER_EVENTS.skillAsk, ask);
    // 被问者是人机：快速自动作答（弃权；不可弃权询问由引擎按默认处理——choice 取第一项、pickCards 取最前牌）
    const askedSeat = this.seats.find((s) => s.id === askedId);
    const timeoutMs = askedSeat?.isBot ? this.botAskMs : ask.timeoutMs ?? defaultRules.timeout.skillAskMs;
    this.askTimer = setTimeout(() => {
      this.askTimer = null;
      try {
        const cur = this.engine?.currentAsk(askedId);
        if (!cur || this.phase !== 'playing') return;
        const r = this.engine!.resolveAsk(askedId, { askId: cur.askId!, choice: 'decline' });
        if (r.ok) this.afterAction(r);
      } catch (e) {
        this.abortGame(e);
      }
    }, timeoutMs);
  }

  private cancelAskTimer(): void {
    if (this.askTimer) {
      clearTimeout(this.askTimer);
      this.askTimer = null;
    }
  }

  private async onFinished(): Promise<void> {
    const snap = this.engine!.snapshotFor(this.seats[0]!.id);
    this.phase = 'finished';
    this.lastWinnerId = snap.winnerId;
    this.lastDeltas = snap.scoreDeltas;
    this.totals = { ...snap.totals };
    this.broadcastState();
    void this.scoreStore
      .add({
        at: new Date().toISOString(),
        roomId: this.code,
        winnerId: snap.winnerId,
        players: this.seats.map((s) => ({
          id: s.id,
          name: s.name,
          roleId: s.roleId,
          score: snap.scoreDeltas?.[s.id] ?? 0,
        })),
      })
      .catch((e) => console.error('[战绩] 写入失败', e));
  }

  private scheduleAutoPass(playerId: string): void {
    this.cancelAutoPass(playerId);
    const timer = setTimeout(() => {
      this.autoPassTimers.delete(playerId);
      try {
        const seat = this.seats.find((s) => s.id === playerId);
        if (!seat || seat.connected || !this.engine) return;
        const turnId = this.engine.snapshotFor(this.seats[0]!.id).turnPlayerId;
        if (turnId !== playerId) return;
        // 有技能询问挂起：动作全部被拦，等询问了结后重排定时器
        if (this.engine.pendingAskPlayerId) {
          this.scheduleAutoPass(playerId);
          return;
        }
        const r = autoPlayFallback(this.engine, playerId, defaultRules);
        if (r && r.ok) this.afterAction(r);
      } catch (e) {
        this.abortGame(e);
      }
    }, this.autoPassMs);
    this.autoPassTimers.set(playerId, timer);
  }

  private cancelAutoPass(playerId: string): void {
    const t = this.autoPassTimers.get(playerId);
    if (t) {
      clearTimeout(t);
      this.autoPassTimers.delete(playerId);
    }
  }

  // ---------- 人机 ----------

  /** 每次动作结算后：轮到人机则排定时器自动行动 */
  private scheduleBotTurn(): void {
    this.cancelBotTurn();
    if (!this.engine || this.phase !== 'playing') return;
    const turnId = this.engine.snapshotFor(this.seats[0]!.id).turnPlayerId;
    if (!turnId) return;
    const seat = this.seats.find((s) => s.id === turnId);
    if (!seat?.isBot) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.botAct(turnId);
    }, this.botTurnMs);
  }

  /** 人机行动：能管就管（最小组合逐个尝试，规避留 2 禁收尾等拒绝），管不了就过
   *  （吃过饼不能过、起牌必须出等由引擎兜底） */
  private botAct(botId: string): void {
    const engine = this.engine;
    if (!engine || this.phase !== 'playing') return;
    // 技能询问挂起：动作被拦，询问了结后 afterAction 会重排（此处兜底自愈）
    if (engine.pendingAskPlayerId) {
      this.scheduleBotTurn();
      return;
    }
    if (engine.snapshotFor(this.seats[0]!.id).turnPlayerId !== botId) return;
    const mySnap = engine.snapshotFor(botId);
    const hand = mySnap.players.find((p) => p.id === botId)?.hand ?? [];
    const combos = listPlayable(
      hand,
      mySnap.table,
      defaultRules,
      mySnap.orderReversed,
      engine.soloJokerAllowed(botId)
    );
    let r: ActionResult | null = null;
    for (const combo of combos) {
      const t = engine.playCards(botId, combo.cards.map((c) => c.id));
      if (t.ok) {
        r = t;
        break;
      }
    }
    if (!r) {
      const p = engine.pass(botId);
      if (!p.ok) {
        this.abortGame(new Error('人机无牌可出且不能过（引擎死锁守卫未兜住）'));
        return;
      }
      r = p;
    }
    this.afterAction(r);
  }

  private cancelBotTurn(): void {
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
  }

  private dispatchEvents(events: GameEvent[]): void {
    for (const e of events) {
      // 窃笑（轴承）：查看手牌是私密动作——skill:peek 只发查看者，skill:peeked 只发被查看者
      if (e.type === 'skill:peek') {
        this.sendTo(e.viewerId, SERVER_EVENTS.event, e);
        continue;
      }
      if (e.type === 'skill:peeked') {
        this.sendTo(e.targetId, SERVER_EVENTS.event, e);
        continue;
      }
      // 私密技能播报（开发者自定义摸牌换牌：只发给本人，不广播）
      if (e.type === 'skill:triggered' && e.privateTo) {
        this.sendTo(e.privateTo, SERVER_EVENTS.event, e);
        continue;
      }
      // 引擎的定向拒绝（狂吠选牌不合法、插队被否决等）：只发给当事人（客户端走 error toast），不广播
      if (e.type === 'game:error') {
        this.sendTo(e.playerId, SERVER_EVENTS.error, e.reason);
        continue;
      }
      this.broadcast(SERVER_EVENTS.event, e);
    }
  }

  private syncSnapshots(): void {
    for (const s of this.seats) {
      const socket = this.sockets.get(s.id);
      if (socket) socket.emit(SERVER_EVENTS.snapshot, this.engine!.snapshotFor(s.id));
    }
  }

  private sendTo(playerId: string, ev: string, payload: unknown): void {
    const socket = this.sockets.get(playerId);
    if (socket) socket.emit(ev, payload);
  }

  private broadcast(ev: string, payload: unknown): void {
    for (const socket of this.sockets.values()) socket.emit(ev, payload);
  }

  broadcastState(): void {
    this.broadcast(SERVER_EVENTS.roomUpdated, this.state());
  }
}
