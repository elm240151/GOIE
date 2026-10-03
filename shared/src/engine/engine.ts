// 游戏引擎：状态机 + 回合/轮循环 + 角色钩子分发 + 事件。
// 原则：
// - 服务端权威，客户端只渲染
// - 所有随机走注入 RNG（可复现）
// - 技能优先：每个判定点 = 基础规则校验 → 角色钩子覆写（allowAnyway 放行 / ok:false 否决）
// - 角色只能通过 EngineFacade + ActionMods 有界改牌，无法破坏引擎不变量
// - 技能询问：钩子可返回 ask 挂起动作，服务端询问玩家后 resolveAsk 重跑提问钩子（钩子须纯：返回 ask 前不得改状态）
import { RANK_2, RANK_3, RANK_A, isJoker, isRank, type Card, type Rank } from '../cards';
import { type RuleConfig } from '../config';
import { canBeat, listPlayable, parseCombo, relabelCombo, type Combo } from './combos';
import { buildDeck, shuffle } from './deck';
import { type GameEvent, type GameEventData } from './events';
import { type Rng } from './rng';
import { type GameSnapshot } from './snapshot';
import {
  type ActionMods,
  type AskAnswer,
  type EngineFacade,
  type HookContext,
  type HookResult,
  type PlayerView,
  type RoleDef,
  type RoleHooks,
  type RoleRegistry,
  type SkillActionRequest,
  type SkillAsk,
} from '../roles/types';

export interface EnginePlayer {
  id: string;
  name: string;
  roleId: string;
}

export interface EngineOptions {
  rng: Rng;
  startPlayerId: string;
  roles: RoleRegistry;
  /** 跨局累计分（新局在其上累加） */
  scores?: Record<string, number>;
  /** 测试用：直接指定手牌（跳过发牌），剩余牌进牌堆 */
  handsOverride?: Record<string, Card[]>;
}

export type ActionResult =
  | { ok: true; events: GameEvent[]; suspended?: boolean; pendingAsk?: SkillAsk }
  | { ok: false; reason: string };

type Phase = 'dealing' | 'playing' | 'finished';

interface HookEntry {
  playerId: string;
  role: RoleDef;
  priority: number;
  hook: (...args: never[]) => HookResult | void;
}

type HookOutcome =
  | { vetoed: false; result?: { ok: true; modify?: ActionMods; allowAnyway?: boolean; ask?: SkillAsk } }
  | { vetoed: true; reason: string };

interface PendingAsk {
  ask: SkillAsk;
  /** 被询问的玩家 */
  playerId: string;
  kind: 'hook' | 'cutIn';
  entry: HookEntry | null;
  hookName: keyof RoleHooks | null;
  args: unknown[];
  /** 恢复执行（带答案重跑钩子后的续跑逻辑） */
  resume: (outcome: HookOutcome) => void;
}

export class GameEngine {
  private readonly cfg: RuleConfig;
  private readonly players: EnginePlayer[];
  private readonly roles: RoleRegistry;
  private readonly rng: Rng;
  private readonly startPlayerId: string;
  private readonly handsOverride?: Record<string, Card[]>;

  private phase: Phase = 'dealing';
  private hands = new Map<string, Card[]>();
  private deck: Card[] = [];
  private discarded: Card[] = [];
  private tableCombo: Combo | null = null;
  /** 当前桌面一手牌是谁出的（无名插队的受害者、巨石驱逐的对象；归属可被技能改写） */
  private tableOwnerId = '';
  /** 明置桌旁的边牌（再问补打等：随当前一手牌一起进弃牌堆，公开） */
  private tableSide: Card[] = [];
  /** 响应限制（抽你）：当前桌面一手牌只能由该玩家响应；null = 无限制 */
  private tableResponderRestrict: string | null = null;
  /** 上一手被压的玩家（无名普通响应加牌的对象；新一轮起牌时重置） */
  private prevTableOwnerId: string | null = null;
  /** 上一手被压的牌的花色集合（无名加牌：响应牌与被压牌同花色即触发，X = 同花色响应牌点数总和） */
  private prevTableSuits: Set<number> = new Set();
  /** 上一手被压的牌型（楠王回味：与当前手牌型计算点数总和差；起牌时 null） */
  private prevTableCombo: Combo | null = null;
  private turnPlayerId: string | null = null;
  private roundLeaderId = '';
  private passCount = 0;
  private roundLastPlayerId: string | null = null;
  private winnerId: string | null = null;
  private scores: Record<string, number>;
  private scoreDeltas: Record<string, number> = {};
  private roleStates = new Map<string, unknown>();
  private pendingMods = new Map<string, ActionMods>();
  private forcedPass = new Set<string>();
  /** 红楼梦（地坛）：本轮不得出牌的玩家（轮末生效、下轮结束清除） */
  private activeBan = new Set<string>();
  /** 红楼梦（地坛）：本轮判定成功、下一轮生效的诅咒（被诅咒者 → 取而代之的诅咒者） */
  private pendingBan = new Map<string, string>();
  private pendingEvents: GameEvent[] = [];
  private seq = 0;
  private startRoundDepth = 0;
  private askSeq = 0;
  /** 已淘汰玩家（座位保留但跳过；手牌进弃牌堆、记 −1） */
  private eliminated = new Set<string>();
  /** 翻牌展示区（角色技能必须清空，动作结束断言） */
  private revealedPool: Card[] = [];
  /** 本回合判定牌豁免数（黑脸）；prev = 上一轮遗留 */
  private handLimitExempt = new Map<string, number>();
  private handLimitExemptPrev = new Map<string, number>();
  /** 桌面是否插队打出（无名） */
  private lastPlayWasCutIn = false;
  /** 答疑改点（修勾）：当前桌面一手牌的判定点数被改写（牌型不变；换桌/新一轮时清除） */
  private tableRankNote: { rank: number } | null = null;
  /** 插队后续处理模式与受害者 */
  private aftermathMode: 'normal' | 'cutIn' = 'normal';
  private cutInVictimId: string | null = null;
  private pendingAsk: PendingAsk | null = null;
  /** 牌序切换计数（海棠洄游）：本轮内每打一手 +1，奇数 = 倒序；每轮开始清零（轮末恢复正序） */
  private orderFlipCount = 0;
  /** 刚打出的这一手在哪个牌序下判定（洄游先判后切：提交前记录，巨石触发等按此镜像） */
  private lastPlayOrderReversed = false;
  /** 出牌即切换牌序的角色（RoleDef.flipsOrderOnPlay，按物理出牌者计，含插队） */
  private orderFlippers = new Set<string>();

  constructor(cfg: RuleConfig, players: EnginePlayer[], opts: EngineOptions) {
    if (players.length < cfg.players.min || players.length > cfg.players.max)
      throw new Error(`玩家人数需在 ${cfg.players.min}-${cfg.players.max} 之间`);
    if (!players.some((p) => p.id === opts.startPlayerId)) throw new Error('先手玩家不在房间内');
    this.cfg = cfg;
    this.players = players;
    this.roles = opts.roles;
    this.rng = opts.rng;
    this.startPlayerId = opts.startPlayerId;
    this.handsOverride = opts.handsOverride;
    this.scores = {};
    for (const p of players) this.scores[p.id] = opts.scores?.[p.id] ?? 0;
    for (const p of players) {
      if (this.roles.get(p.roleId)?.flipsOrderOnPlay) this.orderFlippers.add(p.id);
    }
  }

  // ---------- 对外接口 ----------

  /** 开局：发牌、角色 setup、onDeal 钩子、进入第一轮 */
  start(): void {
    if (this.phase !== 'dealing') return;
    for (const p of this.players) this.hands.set(p.id, []);
    if (this.handsOverride) {
      this.applyHandsOverride();
    } else {
      this.deck = shuffle(buildDeck(this.cfg.deck.count), this.rng);
      for (const p of this.players) {
        const n = p.id === this.startPlayerId ? this.cfg.deal.leaderCards : this.cfg.deal.others;
        this.rawDraw(p.id, n);
      }
    }
    // 角色 setup（发牌后可见手牌）
    for (const p of this.players) {
      const role = this.roles.get(p.roleId);
      if (role?.setup) {
        const ctx = this.makeCtx(p.id);
        const state = role.setup({ game: ctx.game, self: ctx.self, rng: this.rng });
        try {
          JSON.stringify(state);
        } catch {
          throw new Error(`角色 ${role.name} 的 setup 状态必须 JSON 安全`);
        }
        this.roleStates.set(p.id, state);
      }
    }
    // onDeal 钩子（发牌本身不可被否决，veto 只忽略其效果）
    for (const entry of this.orderedHooks('onDeal')) {
      const r = this.runHook(entry, []);
      if (!r.vetoed && r.result?.modify) {
        this.applyMods(entry.playerId, r.result.modify);
        if (r.result.modify.extraDealCards && r.result.modify.extraDealCards > 0)
          this.rawDraw(entry.playerId, r.result.modify.extraDealCards);
      }
    }
    this.phase = 'playing';
    this.emit({ type: 'game:started', leaderId: this.startPlayerId });
    this.emit({ type: 'deal:done' });
    this.startRound(this.startPlayerId);
  }

  /** 出牌（基础规则校验 → beforePlay 钩子覆写 → 执行 → afterPlay/打断钩子） */
  playCards(playerId: string, cardIds: number[]): ActionResult {
    if (this.phase !== 'playing') return fail('游戏已结束');
    if (this.pendingAsk) return fail('等待技能响应');
    if (playerId !== this.turnPlayerId) return fail('不是你的回合');
    if (this.activeBan.has(playerId)) return fail('【红楼梦】本回合不得出牌');
    // 响应限制（抽你）：当前桌面一手牌只能由指定玩家响应
    if (this.tableCombo && this.tableResponderRestrict && playerId !== this.tableResponderRestrict) {
      const d = this.players.find((p) => p.id === this.tableResponderRestrict);
      return fail(`【抽你】本回合只能由 ${d?.name ?? '指定玩家'} 响应`);
    }
    const hand = this.hands.get(playerId)!;
    if (cardIds.length === 0) return fail('请选择要出的牌');
    const cards: Card[] = [];
    for (const id of cardIds) {
      const c = hand.find((x) => x.id === id);
      if (!c) return fail('手牌中没有这张牌');
      if (cards.includes(c)) return fail('重复选择了同一张牌');
      cards.push(c);
    }
    const rev = this.orderReversed();
    const combo = parseCombo(cards, this.cfg, rev, this.soloJokerAllowed(playerId));
    if (!combo) return fail('这不是合法牌型（王不能单独打出）');
    const baseLegal = canBeat(combo, this.tableCombo, this.cfg, rev);
    // 留 X 禁止收尾：以单 2/对 2（倒序：单 3/对 3）打完手牌 → 拒绝（技能优先：钩子可 allowAnyway 放行）
    const finishSpecial =
      cards.length === hand.length &&
      (combo.type === 'single' || combo.type === 'pair') &&
      combo.rank === (rev ? RANK_3 : RANK_2);
    return this.runBeforePlayHooks(playerId, combo, baseLegal && !finishSpecial, 0, false, finishSpecial);
  }

  /** 过牌 */
  pass(playerId: string): ActionResult {
    if (this.phase !== 'playing') return fail('游戏已结束');
    if (this.pendingAsk) return fail('等待技能响应');
    if (playerId !== this.turnPlayerId) return fail('不是你的回合');
    if (this.tableCombo === null) return fail('新一轮起牌者必须出牌');
    this.forcedPass.delete(playerId);
    if (!this.cfg.follow.voluntaryPassAllowed && this.legalResponses(playerId).length > 0) {
      return fail('有牌能管，必须出牌');
    }
    for (const entry of this.orderedHooks('onPass')) {
      const r = this.runHook(entry, []);
      if (r.vetoed) return fail(r.reason);
      if (r.result?.modify) {
        this.applyMods(entry.playerId, r.result.modify);
        if (this.phase !== 'playing') return this.ok();
      }
    }
    this.emit({ type: 'passed', playerId });
    this.passCount++;
    if (this.passCount >= this.activeCount() - 1) this.endRound();
    else this.advanceTurn();
    return this.ok();
  }

  /** 主动技动作（game:useSkill → onSkillAction） */
  useSkillAction(playerId: string, req: SkillActionRequest): ActionResult {
    if (this.phase !== 'playing') return fail('游戏已结束');
    if (this.pendingAsk) return fail('等待技能响应');
    if (playerId !== this.turnPlayerId) return fail('不是你的回合');
    const role = this.roles.get(this.players.find((p) => p.id === playerId)!.roleId);
    const action = role?.skillActions?.find((a) => a.skillId === req.skillId);
    if (!role || !action) return fail('技能不存在');
    if (action.when === 'following' && !this.tableCombo) return fail('现在不能发动该技能');
    const hook = role.hooks?.onSkillAction;
    if (!hook) return fail('技能无法发动');
    const entry: HookEntry = { playerId, role, priority: role.priority ?? 0, hook };
    const r = this.runHook(entry, [req]);
    if (r.vetoed) return fail(r.reason);
    if (r.result?.ask) {
      const resume = (outcome: HookOutcome): void => {
        if (!outcome.vetoed && outcome.result?.ask) {
          // 多阶段询问：重挂起
          this.suspend(entry.playerId, entry, 'onSkillAction', [req], resume, outcome.result.ask);
          return;
        }
        if (outcome.vetoed) {
          this.emit({ type: 'game:error', playerId: entry.playerId, reason: outcome.reason });
        }
        this.applyOutcome(entry, outcome);
        this.finishSkillAction(entry.playerId);
      };
      this.suspend(entry.playerId, entry, 'onSkillAction', [req], resume, r.result.ask);
      return this.suspendedOk();
    }
    if (r.result?.modify) {
      this.applyMods(playerId, r.result.modify);
      if (this.phase !== 'playing') return this.ok();
    }
    this.finishSkillAction(playerId);
    return this.ok();
  }

  /** 回答技能询问：重跑提问钩子（带 answer）或处理插队 */
  resolveAsk(playerId: string, answer: AskAnswer): ActionResult {
    if (this.phase !== 'playing') return fail('游戏已结束');
    const p = this.pendingAsk;
    if (!p) return fail('没有待处理的技能询问');
    if (p.playerId !== playerId) return fail('不是你的技能询问');
    if (p.ask.askId !== answer.askId) return fail('询问已失效');
    this.pendingAsk = null;
    // suspend() 会把 PendingAsk.kind 设为 'hook'/'cutIn'（内部调度标签），此处须看 ask.kind
    if (p.ask.kind === 'selfFollow') {
      return this.resolveSelfFollow(playerId, answer);
    }
    if (p.kind === 'cutIn') {
      if (answer.choice !== 'yes' || !answer.cardIds?.length) {
        this.advanceTurn();
        return this.ok();
      }
      const hand = this.hands.get(playerId)!;
      const cards: Card[] = [];
      for (const id of answer.cardIds) {
        const c = hand.find((x) => x.id === id);
        if (!c) {
          this.advanceTurn();
          return fail('手牌中没有这张牌');
        }
        cards.push(c);
      }
      const rev = this.orderReversed();
      const combo = parseCombo(cards, this.cfg, rev);
      if (!combo) {
        this.advanceTurn();
        return fail('这不是合法牌型');
      }
      if (!canBeat(combo, this.tableCombo, this.cfg, rev)) {
        this.advanceTurn();
        return fail('压不过上家的牌');
      }
      // 留 X 禁止收尾：插队同样不能以单 2/对 2（倒序单 3/对 3）打完手牌
      if (
        cards.length === hand.length &&
        (combo.type === 'single' || combo.type === 'pair') &&
        combo.rank === (rev ? RANK_3 : RANK_2)
      ) {
        this.advanceTurn();
        return fail(rev ? '不能以单 3/对 3 打完手牌（倒序禁止收尾）' : '不能以单 2/对 2 打完手牌');
      }
      // 响应限制（抽你）：插队答案也要校验
      if (this.tableResponderRestrict && playerId !== this.tableResponderRestrict) {
        this.advanceTurn();
        return fail(`【抽你】本回合只能由指定玩家响应`);
      }
      const playedSuits = new Set(
        this.tableCombo!.cards.filter((c) => !isJoker(c)).map((c) => c.suit)
      );
      const sameSuit = combo.cards.some((c) => !isJoker(c) && playedSuits.has(c.suit));
      if (!sameSuit) {
        this.advanceTurn();
        return fail('响应牌中需要与被压的牌相同花色的真牌');
      }
      this.requeue(this.commitCutIn(playerId, combo));
      return this.ok();
    }
    const outcome = this.runHook(p.entry!, p.args, { answer });
    p.resume(outcome);
    return this.ok();
  }

  /** 当前挂起的完整询问（服务端重连时重发给被询问者；非本人返回 null） */
  currentAsk(playerId: string): SkillAsk | null {
    const p = this.pendingAsk;
    if (!p || p.playerId !== playerId) return null;
    // 盲抽（hidden pickCards）：只暴露牌背——id 保留供回传，牌面字段掩码，杜绝偷看
    if (p.ask.hidden && p.ask.cards) {
      const masked = p.ask.cards.map((c) => ({ id: c.id, rank: 0, suit: 0 }) as unknown as Card);
      return { ...p.ask, cards: masked };
    }
    return p.ask;
  }

  /** 当前挂起询问的玩家 id（无则 null） */
  get pendingAskPlayerId(): string | null {
    return this.pendingAsk?.playerId ?? null;
  }

  /** 按查看者过滤的完整快照（其他人只发手牌数） */
  snapshotFor(viewerId: string): GameSnapshot {
    return {
      phase: this.phase === 'playing' ? 'playing' : 'finished',
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        roleId: p.roleId,
        handCount: this.hands.get(p.id)?.length ?? 0,
        hand: p.id === viewerId ? [...(this.hands.get(p.id) ?? [])] : null,
        connected: true,
        eliminated: this.eliminated.has(p.id),
        roleState: this.roleStates.get(p.id),
      })),
      deckCount: this.deck.length,
      discardCount: this.discarded.length,
      /** 翻牌展示区：判定牌公开，所有人都能看（角色须在动作内清空） */
      revealed: [...this.revealedPool],
      table: this.tableCombo,
      tableSide: [...this.tableSide],
      orderReversed: this.orderReversed(),
      tableRankNote: this.tableRankNote,
      /** 红楼梦（地坛）：被诅咒（含下一轮生效中）的玩家，界面展示标记 */
      cursedPlayerIds: [...new Set([...this.activeBan, ...this.pendingBan.keys()])],
      turnPlayerId: this.turnPlayerId,
      roundLeaderId: this.roundLeaderId,
      winnerId: this.winnerId,
      scoreDeltas: this.phase === 'finished' ? this.scoreDeltas : null,
      totals: { ...this.scores },
      pendingAsk: this.pendingAsk
        ? {
            askId: this.pendingAsk.ask.askId!,
            playerId: this.pendingAsk.playerId,
            kind: this.pendingAsk.ask.kind,
            prompt: this.pendingAsk.ask.prompt,
            timeoutMs: this.pendingAsk.ask.timeoutMs!,
          }
        : null,
    };
  }

  get playerIds(): string[] {
    return this.players.map((p) => p.id);
  }

  /** 该玩家是否可单王单独打出（橐驼诅咒；服务端掉线兜底/测试用） */
  soloJokerAllowed(playerId: string): boolean {
    const p = this.players.find((x) => x.id === playerId);
    return !!p && !!this.roles.get(p.roleId)?.soloJoker;
  }

  /** 取走未消费的事件（服务端广播用；start() 产生的事件也走这里） */
  drainEvents(): GameEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  // ---------- 回合/轮循环 ----------

  private startRound(leaderId: string, visited: Set<string> = new Set([leaderId])): void {
    this.startRoundDepth++;
    if (this.startRoundDepth > this.players.length + 1) throw new Error('起牌死锁（异常牌局）');
    try {
      // 判定牌豁免只持续一轮（"本回合"）：上一轮的豁免移入 prev 并到期重查
      for (const p of this.players) {
        const cur = this.handLimitExempt.get(p.id) ?? 0;
        if (cur > 0) this.handLimitExemptPrev.set(p.id, cur);
        else this.handLimitExemptPrev.delete(p.id);
        this.handLimitExempt.delete(p.id);
      }
      for (const p of this.players) this.checkHandLimit(p.id);
      if (this.phase !== 'playing') return;
      while (this.eliminated.has(leaderId)) leaderId = this.nextSeat(leaderId);
      if (this.tableCombo) this.discarded.push(...this.tableCombo.cards, ...this.tableSide);
      this.tableCombo = null;
      this.tableSide = [];
      this.tableRankNote = null;
      this.tableOwnerId = '';
      this.tableResponderRestrict = null;
      this.prevTableOwnerId = null;
      this.prevTableSuits = new Set();
      this.prevTableCombo = null;
      this.passCount = 0;
      this.roundLastPlayerId = null;
      this.roundLeaderId = leaderId;
      this.aftermathMode = 'normal';
      this.cutInVictimId = null;
      this.orderFlipCount = 0; // 洄游：每轮恢复正序（隐匿在轮末结算读的是本轮的计数，清零发生在结算之后）
      // 先设 turnPlayerId：死锁守卫干跑 beforePlay 时技能能识别"自己起牌"
      this.turnPlayerId = leaderId;
      // 死锁守卫：起牌者无任何可出牌型（含被技能否决，如纯王手牌/末张 Q）→ 自动过，下家起牌
      if (this.legalLeadCombos(leaderId).length === 0) {
        this.emit({ type: 'passed', playerId: leaderId });
        this.passCount = this.activeCount() - 1;
        const next = this.nextSeat(leaderId);
        if (visited.has(next)) {
          // 全员都无法起牌（纯王手牌且牌局无解）→ 流局
          this.finishDraw();
          return;
        }
        visited.add(next);
        this.startRound(next, visited);
        return;
      }
      this.beginTurn();
    } finally {
      this.startRoundDepth--;
    }
  }

  private beginTurn(): void {
    if (this.eliminated.has(this.turnPlayerId!)) {
      this.advanceTurn();
      return;
    }
    const id = this.turnPlayerId!;
    this.emit({ type: 'turn:started', playerId: id });
    this.runTurnStartHooks(id, 0);
  }

  /** 回合开始钩子：支持询问挂起（开局整备：首回合无摸牌仍有整备阶段，先手技能可发动） */
  private runTurnStartHooks(id: string, index: number): void {
    const hooks = this.orderedHooks('onTurnStart');
    for (let i = index; i < hooks.length; i++) {
      const entry = hooks[i]!;
      const r = this.runHook(entry, []);
      if (!r.vetoed && r.result?.ask) {
        const resume = (outcome: HookOutcome): void => {
          if (!outcome.vetoed && outcome.result?.ask) {
            // 多阶段询问：重挂起
            this.suspend(entry.playerId, entry, 'onTurnStart', [], resume, outcome.result.ask);
            return;
          }
          if (outcome.vetoed) {
            this.emit({ type: 'game:error', playerId: entry.playerId, reason: outcome.reason });
          }
          this.applyOutcome(entry, outcome);
          if (this.phase !== 'playing') return;
          this.runTurnStartHooks(id, i + 1);
        };
        this.suspend(entry.playerId, entry, 'onTurnStart', [], resume, r.result.ask);
        return;
      }
      if (!r.vetoed && r.result?.modify) {
        this.applyMods(entry.playerId, r.result.modify);
        if (this.phase !== 'playing') return;
      }
    }
    // 强制过（技能效果）；红楼梦（地坛）禁出玩家同样轮到他自动过
    if (this.forcedPass.has(id) || this.activeBan.has(id)) {
      this.forcedPass.delete(id);
      this.emit({ type: 'passed', playerId: id });
      this.passCount++;
      if (this.passCount >= this.activeCount() - 1) this.endRound();
      else this.advanceTurn();
    }
  }

  private advanceTurn(): void {
    const mods = this.pendingMods.get(this.turnPlayerId!);
    let skip = 0;
    if (mods) {
      if (mods.skipNextPlayers && mods.skipNextPlayers > 0) {
        skip = mods.skipNextPlayers;
        mods.skipNextPlayers--;
        if (mods.skipNextPlayers === 0) delete mods.skipNextPlayers;
      }
      if (Object.keys(mods).length === 0) this.pendingMods.delete(this.turnPlayerId!);
    }
    this.turnPlayerId = this.nextSeat(this.turnPlayerId!, skip);
    this.beginTurn();
  }

  /** 一轮结束：出牌者摸牌 → 继续起牌 */
  private endRound(): void {
    const lastId = this.roundLastPlayerId!;
    this.runRoundEndHooks(lastId, 0);
  }

  // ---------- 出牌流水线（挂起可恢复） ----------

  private runBeforePlayHooks(
    playerId: string,
    combo: Combo,
    baseLegal: boolean,
    index: number,
    allowAnyway: boolean,
    finishSpecial: boolean
  ): ActionResult {
    const hooks = this.orderedHooks('beforePlay');
    for (let i = index; i < hooks.length; i++) {
      const entry = hooks[i]!;
      const r = this.runHook(entry, [{ combo, table: this.tableCombo }]);
      if (r.vetoed) return fail(r.reason);
      if (r.result?.ask) {
        const resume = (outcome: HookOutcome): void => {
          if (outcome.vetoed) {
            // 恢复后否决：出牌中止（原动作已 ack，改为 game:error 告知）
            this.emit({ type: 'game:error', playerId, reason: outcome.reason });
            return;
          }
          if (outcome.result?.ask) {
            // 多阶段询问：重挂起
            this.suspend(entry.playerId, entry, 'beforePlay', [{ combo, table: this.tableCombo }], resume, outcome.result.ask);
            return;
          }
          this.applyOutcome(entry, outcome);
          const nextAllow = outcome.result?.allowAnyway ? true : allowAnyway;
          this.finishResumed(
            this.runBeforePlayHooks(playerId, combo, baseLegal, i + 1, nextAllow, finishSpecial),
            playerId
          );
        };
        this.suspend(entry.playerId, entry, 'beforePlay', [{ combo, table: this.tableCombo }], resume, r.result.ask);
        return this.suspendedOk();
      }
      if (r.result?.allowAnyway) allowAnyway = true;
      if (r.result?.modify) {
        this.applyMods(entry.playerId, r.result.modify);
        if (this.phase !== 'playing') return this.ok();
      }
    }
    if (!baseLegal && !allowAnyway) return fail(this.beatFailReason(combo, finishSpecial));
    return this.commitPlay(playerId, combo);
  }

  /** 出牌执行（上一手被压的牌进弃牌堆）→ afterPlay → 打断钩子 → 获胜判定 */
  private commitPlay(playerId: string, combo: Combo): ActionResult {
    const flips = this.orderFlippers.has(playerId);
    this.lastPlayOrderReversed = this.orderReversed(); // 洄游先判后切：本手按切换前顺序判定（巨石触发镜像用）
    if (flips) this.orderFlipCount++; // 洄游：物理出牌即切换（先判后切，本手按切换前顺序判定）
    this.removeCards(playerId, combo.cards);
    if (this.tableCombo) this.discarded.push(...this.tableCombo.cards, ...this.tableSide);
    this.tableSide = [];
    this.tableResponderRestrict = null;
    this.tableRankNote = null;
    const prevSuits: Set<number> = this.tableCombo
      ? new Set(this.tableCombo.cards.filter((c) => !isJoker(c)).map((c) => c.suit))
      : new Set();
    const prevCombo = this.tableCombo;
    this.tableCombo = combo;
    if (flips) this.resyncTableOrder(); // 洄游：切换后桌面按新牌序重新解析（rank 约定反转）
    this.prevTableOwnerId = this.tableOwnerId === '' ? null : this.tableOwnerId;
    this.prevTableSuits = this.prevTableOwnerId == null ? new Set<number>() : prevSuits;
    this.prevTableCombo = this.prevTableOwnerId == null ? null : prevCombo;
    this.tableOwnerId = playerId;
    this.roundLastPlayerId = playerId;
    this.passCount = 0;
    this.lastPlayWasCutIn = false;
    this.emit({ type: 'cards:played', playerId, combo });
    return this.runAfterPlayHooks(playerId, combo, 0);
  }

  private runAfterPlayHooks(playerId: string, combo: Combo, index: number): ActionResult {
    const hooks = this.orderedHooks('afterPlay');
    for (let i = index; i < hooks.length; i++) {
      const entry = hooks[i]!;
      const r = this.runHook(entry, [combo]);
      if (!r.vetoed && r.result?.ask) {
        const resume = (outcome: HookOutcome): void => {
          if (outcome.vetoed) return;
          if (outcome.result?.ask) {
            // 多阶段询问：重挂起（阿色再问：确认 → 问压牌者）
            this.suspend(entry.playerId, entry, 'afterPlay', [combo], resume, outcome.result.ask);
            return;
          }
          this.applyOutcome(entry, outcome);
          this.finishResumed(this.runAfterPlayHooks(playerId, combo, i + 1), playerId);
        };
        this.suspend(entry.playerId, entry, 'afterPlay', [combo], resume, r.result.ask);
        return this.suspendedOk();
      }
      if (!r.vetoed && r.result?.modify) {
        this.applyMods(entry.playerId, r.result.modify);
        if (this.phase !== 'playing') return this.ok();
      }
    }
    return this.runInterruptHooks(playerId, combo, 0);
  }

  private runInterruptHooks(playerId: string, combo: Combo, index: number): ActionResult {
    const hooks = this.orderedHooks('onPlayInterrupt');
    for (let i = index; i < hooks.length; i++) {
      const entry = hooks[i]!;
      const r = this.runHook(entry, [combo]);
      if (!r.vetoed && r.result?.ask) {
        const resume = (outcome: HookOutcome): void => {
          if (outcome.vetoed) return;
          if (outcome.result?.ask) {
            // 多阶段询问：重挂起
            this.suspend(entry.playerId, entry, 'onPlayInterrupt', [combo], resume, outcome.result.ask);
            return;
          }
          this.applyOutcome(entry, outcome);
          this.finishResumed(this.runInterruptHooks(playerId, combo, i + 1), playerId);
        };
        this.suspend(entry.playerId, entry, 'onPlayInterrupt', [combo], resume, r.result.ask);
        return this.suspendedOk();
      }
      if (!r.vetoed && r.result?.modify) {
        this.applyMods(entry.playerId, r.result.modify);
        if (this.phase !== 'playing') return this.ok();
      }
    }
    return this.afterPlayCommitted(playerId);
  }

  /** 无名加牌 X：响应牌（当前桌面）中与被压牌同花色的真牌点数总和；0 = 无同花色 */
  private matchSuitDrawX(): number {
    return this.tableCombo!.cards
      .filter((c) => !isJoker(c) && this.prevTableSuits.has(c.suit))
      .reduce((s, c) => s + c.rank, 0);
  }

  /** 出牌后的收尾：夺权 → 出完即胜/留2判负 → 插队/无名加牌后续 → 插队问询/轮到下家 */
  private afterPlayCommitted(playerId: string): ActionResult {
    const ownerId = this.roundLastPlayerId!;
    // 夺权（巨石驱逐成功）：桌面作废，由技能所有者起牌
    for (const p of this.players) {
      const mods = this.pendingMods.get(p.id);
      if (mods?.seizeLead) {
        delete mods.seizeLead;
        if (Object.keys(mods).length === 0) this.pendingMods.delete(p.id);
        if (this.phase === 'playing') {
          if (this.tableCombo) this.discarded.push(...this.tableCombo.cards);
          this.tableCombo = null;
          this.tableRankNote = null;
          this.aftermathMode = 'normal';
          this.cutInVictimId = null;
          this.startRound(p.id);
        }
        return this.ok();
      }
    }
    // 出完即胜（被淘汰者不算）：谁打完谁赢——归属改写（再问）不改胜利判定，按物理出牌者判；
    // 留 X 禁止收尾已在出牌校验层拦截（单 2/对 2 打完手牌不可出），走到这里即为正常出完
    if (!this.eliminated.has(playerId) && this.hands.get(playerId)!.length === 0) {
      this.finishGame(playerId);
      return this.ok();
    }
    // 插队后续（无名）：受害者摸 X 张，轮转从无名的下家继续（插队跳过了中间的人）
    if (this.aftermathMode === 'cutIn') {
      this.aftermathMode = 'normal';
      const victimId = this.cutInVictimId!;
      this.cutInVictimId = null;
      const x = this.matchSuitDrawX();
      if (this.phase === 'playing' && !this.eliminated.has(victimId)) this.drawCards(victimId, x);
      if (this.phase !== 'playing') return this.ok();
      this.turnPlayerId = this.nextSeat(ownerId);
      this.beginTurn();
      return this.ok();
    }
    // 无名普通响应加牌：响应牌中有与被压牌同花色的真牌（单张也可）→ 被响应者摸 X 张，轮转正常继续
    if (
      !this.lastPlayWasCutIn &&
      this.prevTableOwnerId != null &&
      !this.eliminated.has(this.prevTableOwnerId) &&
      this.tableCombo
    ) {
      const owner = this.players.find((p) => p.id === ownerId);
      const x = this.matchSuitDrawX();
      if (owner && this.roles.get(owner.roleId)?.canCutIn && x > 0) {
        this.drawCards(this.prevTableOwnerId, x);
        if (this.phase !== 'playing') return this.ok();
      }
    }
    // 狂吠（修勾）：出牌者可以立刻压自己打出的牌，可连压到放弃/压不了（压完走完整流水线，狂吠可再次触发）
    const selfId = this.roundLastPlayerId!;
    if (
      this.tableCombo &&
      !this.eliminated.has(selfId) &&
      !this.activeBan.has(selfId) &&
      this.roles.get(this.players.find((p) => p.id === selfId)!.roleId)?.canSelfFollow &&
      listPlayable(
        this.hands.get(selfId)!,
        this.tableCombo,
        this.cfg,
        this.orderReversed(),
        this.soloJokerAllowed(selfId)
      ).length > 0
    ) {
      this.suspend(selfId, null, null, [], () => {}, {
        kind: 'selfFollow',
        prompt: '【狂吠】要压自己打出的牌吗？（按正常管牌规则，可连压；选牌提交，放弃则轮到下家）',
      });
      return this.suspendedOk();
    }
    return this.offerCutIn();
  }

  // ---------- 狂吠（修勾）：压自己打出的牌 ----------

  /** 狂吠答案：放弃 → 轮到下家；选牌 → 校验后压自己的牌（非法选牌重新询问，不消耗机会） */
  private resolveSelfFollow(playerId: string, answer: AskAnswer): ActionResult {
    if (answer.choice !== 'yes' || !answer.cardIds?.length) {
      this.advanceTurn();
      return this.ok();
    }
    const hand = this.hands.get(playerId)!;
    const cards: Card[] = [];
    for (const id of answer.cardIds) {
      const c = hand.find((x) => x.id === id);
      if (!c) return this.reaskSelfFollow(playerId, '手牌中没有这张牌');
      cards.push(c);
    }
    const rev = this.orderReversed();
    const combo = parseCombo(cards, this.cfg, rev);
    if (!combo) return this.reaskSelfFollow(playerId, '这不是合法牌型');
    if (!canBeat(combo, this.tableCombo, this.cfg, rev)) return this.reaskSelfFollow(playerId, '压不过自己的牌');
    // 留 X 禁止收尾：狂吠同样不能以单 2/对 2（倒序单 3/对 3）打完手牌
    if (
      cards.length === hand.length &&
      (combo.type === 'single' || combo.type === 'pair') &&
      combo.rank === (rev ? RANK_3 : RANK_2)
    ) {
      return this.reaskSelfFollow(
        playerId,
        rev ? '不能以单 3/对 3 打完手牌（倒序禁止收尾）' : '不能以单 2/对 2 打完手牌'
      );
    }
    this.requeue(this.commitSelfFollow(playerId, combo));
    return this.ok();
  }

  /** 非法选牌：播报原因并重新询问（服务端经 afterAction 把新询问发给玩家） */
  private reaskSelfFollow(playerId: string, reason: string): ActionResult {
    this.emit({ type: 'game:error', playerId, reason });
    this.suspend(playerId, null, null, [], () => {}, {
      kind: 'selfFollow',
      prompt: '【狂吠】要压自己打出的牌吗？（按正常管牌规则，可连压；选牌提交，放弃则轮到下家）',
    });
    return this.ok();
  }

  /** 狂吠提交：压自己的牌（无插队后续），走完整流水线——获胜判定/打断钩子/狂吠连压照常 */
  private commitSelfFollow(playerId: string, combo: Combo): ActionResult {
    const flips = this.orderFlippers.has(playerId);
    this.lastPlayOrderReversed = this.orderReversed(); // 同上：狂吠连压也按切换前顺序判定
    if (flips) this.orderFlipCount++;
    this.removeCards(playerId, combo.cards);
    if (this.tableCombo) this.discarded.push(...this.tableCombo.cards, ...this.tableSide);
    this.tableSide = [];
    this.tableResponderRestrict = null;
    this.tableRankNote = null;
    const prevSuits: Set<number> = this.tableCombo
      ? new Set(this.tableCombo.cards.filter((c) => !isJoker(c)).map((c) => c.suit))
      : new Set();
    const prevCombo = this.tableCombo;
    this.tableCombo = combo;
    if (flips) this.resyncTableOrder();
    this.prevTableOwnerId = this.tableOwnerId === '' ? null : this.tableOwnerId;
    this.prevTableSuits = this.prevTableOwnerId == null ? new Set<number>() : prevSuits;
    this.prevTableCombo = this.prevTableOwnerId == null ? null : prevCombo;
    this.tableOwnerId = playerId;
    this.roundLastPlayerId = playerId;
    this.passCount = 0;
    this.lastPlayWasCutIn = false;
    this.emit({ type: 'cards:played', playerId, combo });
    return this.runAfterPlayHooks(playerId, combo, 0);
  }

  // ---------- 插队（无名） ----------

  private offerCutIn(): ActionResult {
    if (this.lastPlayWasCutIn || !this.tableCombo) {
      this.advanceTurn();
      return this.ok();
    }
    const cutter = this.players.find(
      (p) =>
        this.roles.get(p.roleId)?.canCutIn &&
        !this.eliminated.has(p.id) &&
        !this.activeBan.has(p.id) &&
        p.id !== this.roundLastPlayerId &&
        // 响应限制（抽你）：非指定玩家不得插队响应
        !(this.tableResponderRestrict && p.id !== this.tableResponderRestrict)
    );
    if (!cutter) {
      this.advanceTurn();
      return this.ok();
    }
    // 插队者本来就是下家则无需插队
    if (this.nextSeat(this.roundLastPlayerId!) === cutter.id) {
      this.advanceTurn();
      return this.ok();
    }
    const playedSuits = new Set(this.tableCombo.cards.filter((c) => !isJoker(c)).map((c) => c.suit));
    const qualifying = listPlayable(
      this.hands.get(cutter.id)!,
      this.tableCombo,
      this.cfg,
      this.orderReversed(),
      this.soloJokerAllowed(cutter.id)
    ).some((c) => c.cards.some((card) => !isJoker(card) && playedSuits.has(card.suit)));
    if (!qualifying) {
      this.advanceTurn();
      return this.ok();
    }
    this.suspend(cutter.id, null, null, [], () => {}, { kind: 'cutIn', prompt: '是否抢先接牌？' });
    return this.suspendedOk();
  }

  private commitCutIn(playerId: string, combo: Combo): ActionResult {
    const flips = this.orderFlippers.has(playerId);
    if (flips) this.orderFlipCount++; // 插队也是物理出牌：洄游照常切换
    this.aftermathMode = 'cutIn';
    this.cutInVictimId = this.tableOwnerId;
    this.removeCards(playerId, combo.cards);
    const prevSuits: Set<number> = this.tableCombo
      ? new Set(this.tableCombo.cards.filter((c) => !isJoker(c)).map((c) => c.suit))
      : new Set();
    if (this.tableCombo) this.discarded.push(...this.tableCombo.cards);
    const prevCombo = this.tableCombo;
    this.tableCombo = combo;
    this.tableRankNote = null;
    if (flips) this.resyncTableOrder(); // 洄游：切换后桌面按新牌序重新解析（rank 约定反转）
    this.prevTableOwnerId = this.tableOwnerId === '' ? null : this.tableOwnerId;
    this.prevTableSuits = this.prevTableOwnerId == null ? new Set<number>() : prevSuits;
    this.prevTableCombo = this.prevTableOwnerId == null ? null : prevCombo;
    this.tableOwnerId = playerId;
    this.roundLastPlayerId = playerId;
    this.passCount = 0;
    this.lastPlayWasCutIn = true;
    this.emit({ type: 'cards:played', playerId, combo });
    return this.runAfterPlayHooks(playerId, combo, 0);
  }

  // ---------- 轮末 ----------

  private runRoundEndHooks(lastId: string, index: number): void {
    const hooks = this.orderedHooks('onRoundEnd');
    for (let i = index; i < hooks.length; i++) {
      const entry = hooks[i]!;
      const r = this.runHook(entry, [lastId]);
      if (!r.vetoed && r.result?.ask) {
        const resume = (outcome: HookOutcome): void => {
          if (!outcome.vetoed && outcome.result?.ask) {
            // 多阶段询问：重挂起
            this.suspend(entry.playerId, entry, 'onRoundEnd', [lastId], resume, outcome.result.ask);
            return;
          }
          if (outcome.vetoed) {
            this.emit({ type: 'game:error', playerId: entry.playerId, reason: outcome.reason });
          }
          this.applyOutcome(entry, outcome);
          if (this.phase !== 'playing') return;
          this.runRoundEndHooks(lastId, i + 1);
        };
        this.suspend(entry.playerId, entry, 'onRoundEnd', [lastId], resume, r.result.ask);
        return;
      }
      if (!r.vetoed && r.result?.modify) {
        this.applyMods(entry.playerId, r.result.modify);
        if (this.phase !== 'playing') return;
      }
    }
    this.finishRoundEnd(lastId);
  }

  private finishRoundEnd(lastId: string): void {
    const mods = this.pendingMods.get(lastId);
    let suppress = false;
    if (mods?.suppressDraw) {
      delete mods.suppressDraw;
      suppress = true;
    }

    if (mods && Object.keys(mods).length === 0) this.pendingMods.delete(lastId);
    // 地坛取而代之：被诅咒者本回合轮末获得牌权 → 诅咒者代替摸牌并起新回合
    const seizedBy = this.pendingBan.get(lastId);
    const takenOver = !!seizedBy && !this.eliminated.has(seizedBy);
    const drawId = takenOver ? seizedBy : lastId;
    let drew = 0;
    if (!suppress && this.cfg.roundEnd.lastPlayerDraws && this.cfg.roundEnd.drawCount > 0) {
      drew = this.drawCards(drawId, this.cfg.roundEnd.drawCount);
    }
    if (this.phase !== 'playing') return;
    // 轮更：本轮判定成功的诅咒下一轮生效
    this.activeBan = new Set(this.pendingBan.keys());
    this.pendingBan.clear();
    let leader = drawId;
    if (this.eliminated.has(leader)) leader = this.nextSeat(leader);
    // 防御：被诅咒者不得到牌权就跳过（取而代之者被淘汰等边缘），起牌者绝不能是禁出玩家
    if (this.activeBan.has(leader)) {
      const alt = this.players.find((p) => !this.eliminated.has(p.id) && !this.activeBan.has(p.id));
      if (alt) leader = alt.id;
    }
    this.emit({ type: 'round:ended', lastPlayerId: lastId, drew, ledBy: takenOver ? seizedBy : undefined });
    this.startRound(leader);
  }

  private finishGame(winnerId: string): void {
    this.phase = 'finished';
    this.winnerId = winnerId;
    this.turnPlayerId = null;
    this.aftermathMode = 'normal';
    this.cutInVictimId = null;
    for (const entry of this.orderedHooks('onGameEnd')) {
      const r = this.runHook(entry, [winnerId]);
      if (!r.vetoed && r.result?.modify) this.applyMods(entry.playerId, r.result.modify);
    }
    const deltas: Record<string, number> = {};
    for (const p of this.players) {
      const base = p.id === winnerId ? this.players.length - 1 : this.cfg.scoring.loser;
      const mod = this.pendingMods.get(p.id)?.scoreDelta ?? 0;
      deltas[p.id] = base + mod;
      this.scores[p.id] = (this.scores[p.id] ?? 0) + base + mod;
    }
    this.scoreDeltas = deltas;
    this.emit({ type: 'game:ended', winnerId, scoreDeltas: deltas, totals: { ...this.scores } });
  }

  /** 流局：全员都无法起牌（纯王手牌且无解），无胜负、不记分、不触发 onGameEnd 钩子 */
  private finishDraw(): void {
    this.phase = 'finished';
    this.turnPlayerId = null;
    const deltas: Record<string, number> = {};
    for (const p of this.players) deltas[p.id] = 0;
    this.scoreDeltas = deltas;
    this.emit({ type: 'game:ended', winnerId: null, scoreDeltas: deltas, totals: { ...this.scores } });
  }

  // ---------- 摸牌/移牌/淘汰 ----------

  /** 测试用：跳过发牌直接指定手牌，剩余牌进牌堆 */
  private applyHandsOverride(): void {
    for (const p of this.players) this.hands.set(p.id, [...(this.handsOverride![p.id] ?? [])]);
    const used = new Set<number>();
    for (const h of this.hands.values()) for (const c of h) used.add(c.id);
    this.deck = buildDeck(this.cfg.deck.count).filter((c) => !used.has(c.id));
  }

  /** 正常摸牌：onDraw 钩子 → drawBonus → 原始摸牌 */
  private drawCards(playerId: string, n: number): number {
    for (const entry of this.orderedHooks('onDraw')) {
      const r = this.runHook(entry, [n]);
      if (r.vetoed) return 0;
      if (r.result?.modify) {
        this.applyMods(entry.playerId, r.result.modify);
        if (this.phase !== 'playing') return 0;
      }
    }
    const bonus = this.takeDrawBonus(playerId);
    const actual = this.rawDraw(playerId, n + bonus);
    if (actual > 0) this.emit({ type: 'cards:drawn', playerId, count: actual });
    return actual;
  }

  /** 原始摸牌（不走钩子、不吃 drawBonus） */
  private rawDraw(playerId: string, n: number): number {
    if (n <= 0) return 0;
    const actual = Math.min(n, this.deck.length);
    const drawn = this.deck.splice(this.deck.length - actual, actual);
    const hand = this.hands.get(playerId);
    if (hand) {
      hand.push(...drawn);
      this.checkHandLimit(playerId);
    }
    return actual;
  }

  private removeCards(playerId: string, cards: Card[]): void {
    const hand = this.hands.get(playerId)!;
    const ids = new Set(cards.map((c) => c.id));
    this.hands.set(playerId, hand.filter((c) => !ids.has(c.id)));
  }

  private takeDrawBonus(playerId: string): number {
    const mods = this.pendingMods.get(playerId);
    const bonus = mods?.drawBonus ?? 0;
    if (mods && bonus > 0) {
      delete mods.drawBonus;
      if (Object.keys(mods).length === 0) this.pendingMods.delete(playerId);
    }
    return bonus;
  }

  private applyMods(playerId: string, mods: ActionMods): void {
    if (mods.forcePass?.length) for (const id of mods.forcePass) this.forcedPass.add(id);
    if (mods.eliminate?.length) for (const id of mods.eliminate) this.eliminate(id, '被技能淘汰');
    const cur = this.pendingMods.get(playerId) ?? {};
    if (mods.drawBonus) cur.drawBonus = (cur.drawBonus ?? 0) + mods.drawBonus;
    if (mods.scoreDelta) cur.scoreDelta = (cur.scoreDelta ?? 0) + mods.scoreDelta;
    if (mods.skipNextPlayers) cur.skipNextPlayers = (cur.skipNextPlayers ?? 0) + mods.skipNextPlayers;
    if (mods.suppressDraw) cur.suppressDraw = true;
    if (mods.endTurn) cur.endTurn = true;
    if (mods.seizeLead) cur.seizeLead = true;
    if (Object.keys(cur).length === 0) this.pendingMods.delete(playerId);
    else this.pendingMods.set(playerId, cur);
  }

  /** 淘汰：手牌进弃牌堆、记 −1、座位保留但跳过；仅剩一人时其直接获胜 */
  private eliminate(playerId: string, reason: string): void {
    if (this.eliminated.has(playerId) || this.phase === 'finished') return;
    this.eliminated.add(playerId);
    // 桌面一手牌的主人被淘汰：其响应限制随之解除（手牌仍留在桌上等别人压）
    if (this.tableOwnerId === playerId) this.tableResponderRestrict = null;
    const hand = this.hands.get(playerId) ?? [];
    this.hands.set(playerId, []);
    if (hand.length > 0) this.discarded.push(...hand);
    this.pendingMods.delete(playerId);
    this.forcedPass.delete(playerId);
    this.activeBan.delete(playerId);
    this.pendingBan.delete(playerId);
    this.emit({ type: 'player:eliminated', playerId, reason });
    this.passCount = Math.min(this.passCount, Math.max(0, this.activeCount() - 1));
    if (this.activeCount() === 1) {
      const only = this.players.find((p) => !this.eliminated.has(p.id))!;
      this.finishGame(only.id);
    }
  }

  /** 手牌上限检查（发牌阶段豁免；黑脸判定牌按豁免计） */
  private checkHandLimit(playerId: string): void {
    if (this.phase === 'dealing' || !this.cfg.hand.overLimitEliminate) return;
    if (this.eliminated.has(playerId)) return;
    const hand = this.hands.get(playerId);
    if (!hand) return;
    const exempt = (this.handLimitExempt.get(playerId) ?? 0) + (this.handLimitExemptPrev.get(playerId) ?? 0);
    if (hand.length - exempt > this.cfg.hand.limit) this.eliminate(playerId, '手牌超过上限');
  }

  private activeCount(): number {
    return this.players.filter((p) => !this.eliminated.has(p.id)).length;
  }

  // ---------- 翻牌展示区 ----------

  /** 翻牌堆顶 n 张到展示区（角色须 takeRevealed/giveRevealed/discardRevealed 收尾） */
  private revealTop(n: number): Card[] {
    const actual = Math.min(Math.max(0, n), this.deck.length);
    const cards = this.deck.splice(this.deck.length - actual, actual);
    this.revealedPool.push(...cards);
    return [...cards];
  }

  /** 展示区指定牌 → 手牌（exempt = 判定牌，本回合不计上限） */
  private moveRevealedToHand(playerId: string, cardIds: number[], exempt: boolean): void {
    const ids = new Set(cardIds);
    const taken = this.revealedPool.filter((c) => ids.has(c.id));
    if (taken.length === 0) return;
    this.revealedPool = this.revealedPool.filter((c) => !ids.has(c.id));
    const hand = this.hands.get(playerId);
    if (!hand) {
      this.discarded.push(...taken);
      return;
    }
    hand.push(...taken);
    if (exempt) this.handLimitExempt.set(playerId, (this.handLimitExempt.get(playerId) ?? 0) + taken.length);
    this.checkHandLimit(playerId);
  }

  /** 展示区指定牌（缺省全部）→ 弃牌堆 */
  private discardRevealed(cardIds?: number[]): void {
    if (!cardIds) {
      this.discarded.push(...this.revealedPool);
      this.revealedPool = [];
      return;
    }
    const ids = new Set(cardIds);
    this.discarded.push(...this.revealedPool.filter((c) => ids.has(c.id)));
    this.revealedPool = this.revealedPool.filter((c) => !ids.has(c.id));
  }

  // ---------- 角色钩子 ----------

  private orderedHooks(name: keyof RoleHooks): HookEntry[] {
    const entries: HookEntry[] = [];
    for (const p of this.players) {
      if (this.eliminated.has(p.id)) continue;
      const role = this.roles.get(p.roleId);
      const hook = role?.hooks?.[name];
      if (hook) entries.push({ playerId: p.id, role, priority: role.priority ?? 0, hook: hook as never });
    }
    const seatOf = (id: string) => this.players.findIndex((p) => p.id === id);
    return entries.sort((a, b) => b.priority - a.priority || seatOf(a.playerId) - seatOf(b.playerId));
  }

  private runHook(
    entry: HookEntry,
    args: unknown[],
    opts?: { answer?: AskAnswer; dryRun?: boolean }
  ): HookOutcome {
    try {
      const result = (entry.hook as (...a: unknown[]) => HookResult | void)(this.makeCtx(entry.playerId, opts), ...args);
      if (result && result.ok === false) return { vetoed: true, reason: result.reason };
      if (result && result.ok) {
        // 干跑（死锁守卫）：ask 不挂起、modify 不生效
        if (opts?.dryRun) return result.ask ? { vetoed: false } : { vetoed: false, result };
        return { vetoed: false, result };
      }
      return { vetoed: false };
    } catch {
      return { vetoed: true, reason: '技能执行出错' };
    }
  }

  private applyOutcome(entry: HookEntry, outcome: HookOutcome): void {
    if (!outcome.vetoed && outcome.result?.modify) this.applyMods(entry.playerId, outcome.result.modify);
  }

  /** 挂起恢复后的流水线结果：失败转 game:error 事件（原始动作已 ack 成功） */
  private finishResumed(r: ActionResult, playerId: string): void {
    if (!r.ok) {
      this.emit({ type: 'game:error', playerId, reason: r.reason });
      return;
    }
    this.requeue(r);
  }

  /** 嵌套动作（恢复/插队/强制出牌）内部排空的事件重新排回待广播队列，由最外层动作统一广播 */
  private requeue(r: ActionResult): void {
    if (r.ok) for (const e of r.events) this.pendingEvents.push(e);
  }

  private makeCtx(playerId: string, opts?: { answer?: AskAnswer; dryRun?: boolean }): HookContext {
    return {
      game: this.facadeFor(playerId, opts),
      self: this.viewOf(playerId),
      state: this.roleStates.get(playerId),
      rng: this.rng,
      answer: opts?.answer,
      dryRun: opts?.dryRun,
    };
  }

  private viewOf(playerId: string): PlayerView {
    const p = this.players.find((x) => x.id === playerId)!;
    return {
      id: p.id,
      name: p.name,
      roleId: p.roleId,
      handCount: this.hands.get(p.id)?.length ?? 0,
      hand: [...(this.hands.get(p.id) ?? [])],
    };
  }

  private facadeFor(playerId: string, opts?: { answer?: AskAnswer; dryRun?: boolean }): EngineFacade {
    const engine = this;
    return {
      cfg: this.cfg,
      players: () => engine.players.map((p) => engine.viewOf(p.id)),
      handOf: (id) => engine.hands.get(id) ?? [],
      deckCount: () => engine.deck.length,
      table: () => engine.tableCombo,
      prevTable: () => engine.prevTableCombo,
      prevTableOwnerId: () => engine.prevTableOwnerId,
      turnPlayerId: () => engine.turnPlayerId ?? '',
      roundLeaderId: () => engine.roundLeaderId,
      phase: () => engine.phase,
      passCount: () => engine.passCount,
      roundLastPlayerId: () => engine.roundLastPlayerId,
      nextSeatOf: (id, skip = 0) => engine.nextSeat(id, skip),
      draw: (id, n) => {
        engine.rawDraw(id, n);
      },
      giveFrom: (id, cardIds) => {
        const hand = engine.hands.get(id) ?? [];
        const ids = new Set(cardIds);
        engine.hands.set(id, hand.filter((c) => !ids.has(c.id)));
      },
      giveTo: (id, cards) => {
        const hand = engine.hands.get(id);
        if (!hand || cards.length === 0) return;
        hand.push(...cards);
        engine.checkHandLimit(id);
      },
      announce: (roleId, skillId, text) => {
        if (!opts?.dryRun) engine.emit({ type: 'skill:triggered', playerId, roleId, skillId, text });
      },
      revealTop: (n, purpose) => {
        const cards = engine.revealTop(n);
        // 每张判定牌公开：逐次翻牌各发一次事件（儒艮一张一张亮），干跑不发声
        if (!opts?.dryRun && cards.length > 0)
          engine.emit({ type: 'cards:revealed', playerId, cards, purpose: purpose ?? '翻牌' });
        return cards;
      },
      takeRevealed: (id, cardIds) => engine.moveRevealedToHand(id, cardIds, true),
      giveRevealed: (id, cardIds) => engine.moveRevealedToHand(id, cardIds, false),
      discardRevealed: (cardIds) => engine.discardRevealed(cardIds),
      revealCards: (cards, purpose) => {
        engine.emit({ type: 'cards:revealed', playerId, cards, purpose });
      },
      playForcedCombo: (combo) => {
        // 校验后走正常出牌提交流程（含 afterPlay/打断/获胜判定/插队问询）
        // 张数下限放宽为 1（茄汤一元炸/二元炸），上限不变
        const hand = engine.hands.get(playerId) ?? [];
        if (combo.cards.length < 1 || combo.cards.length > engine.cfg.bomb.maxSize)
          throw new Error('炸弹张数不合法');
        if (!combo.cards.every((c) => hand.some((h) => h.id === c.id))) throw new Error('手牌中没有这些牌');
        if (!combo.cards.some((c) => isRank(c.rank))) throw new Error('炸弹至少需要一张真牌');
        engine.requeue(engine.commitPlay(playerId, combo));
      },
      eliminated: (id) => engine.eliminated.has(id),
      activeCount: () => engine.activeCount(),
      lastPlayWasCutIn: () => engine.lastPlayWasCutIn,
      respondedTo: () => engine.prevTableOwnerId,
      respondedToSuits: () => [...engine.prevTableSuits],
      attributeTable: (ownerId) => engine.attributeTable(ownerId),
      setTableResponderRestrict: (designatedId) => {
        engine.tableResponderRestrict = designatedId;
      },
      playSideCard: (pid, cardId) => engine.playSideCard(pid, cardId),
      orderReversed: () => engine.orderReversed(),
      lastPlayOrderReversed: () => engine.lastPlayOrderReversed,
      flipCountThisRound: () => engine.orderFlipCount,
      discardFromHand: (id, cardIds) => engine.discardFromHand(id, cardIds),
      retagTable: (rank) => engine.retagTable(rank),
      curseNextRound: (targetId) => engine.curseNextRound(playerId, targetId),
    };
  }

  /** 当前是否倒序（海棠洄游：本轮出牌切换计数为奇数） */
  private orderReversed(): boolean {
    return this.orderFlipCount % 2 === 1;
  }

  /**
   * 洄游切换后把桌面牌型按新牌序重新解析：倒序的 rank = 最高点数，正倒切换必须
   * 同步重算，否则跨序比较（如顺子窗口公式）会用错约定。仅在切换者出牌后调用，
   * 普通出牌不重解析（避免覆盖技能改写过的 combo）。
   */
  private resyncTableOrder(): void {
    if (!this.tableCombo) return;
    const reparsed = parseCombo(this.tableCombo.cards, this.cfg, this.orderReversed());
    if (reparsed) this.tableCombo = reparsed;
  }

  /**
   * 答疑（修勾）：把当前桌面一手牌的判定点数改为指定值——牌型不变（顺子/连对 = 起点，
   * 按当前牌序约定：正序 = 最低点、倒序 = 最高点），后续管牌判定一律按新点数。
   * 改点只影响判定，不改实体牌（巨石/无名加牌等按实体牌判定）。
   */
  private retagTable(rank: number): void {
    if (!this.tableCombo) return;
    if (!Number.isInteger(rank) || rank < RANK_3 || rank > RANK_A) return;
    // label 同步重写为改点后的牌型（快照里桌面主显新点数；实体牌不变）
    this.tableCombo = relabelCombo(this.tableCombo, rank as Rank, this.orderReversed());
    this.tableRankNote = { rank };
  }

  /** 地坛（橐驼）：诅咒目标玩家下一轮不得出牌（自动过、不能起牌/插队/狂吠）；
   *  若其本回合轮末获得牌权，由诅咒者取而代之（摸牌 + 起新回合）。轮末生效、下轮结束清除。 */
  private curseNextRound(bannerId: string, targetId: string): void {
    if (targetId === bannerId) return;
    const target = this.players.find((p) => p.id === targetId);
    if (!target || this.eliminated.has(targetId)) return;
    this.pendingBan.set(targetId, bannerId);
  }

  /** 手牌指定牌 → 弃牌堆（隐匿重铸等） */
  private discardFromHand(playerId: string, cardIds: number[]): void {
    const hand = this.hands.get(playerId);
    if (!hand) return;
    const ids = new Set(cardIds);
    const taken = hand.filter((c) => ids.has(c.id));
    if (taken.length === 0) return;
    this.hands.set(playerId, hand.filter((c) => !ids.has(c.id)));
    this.discarded.push(...taken);
  }

  // ---------- 询问挂起 ----------

  private suspend(
    playerId: string,
    entry: HookEntry | null,
    hookName: keyof RoleHooks | null,
    args: unknown[],
    resume: (outcome: HookOutcome) => void,
    ask: SkillAsk
  ): void {
    ask.askId = ask.askId ?? this.newAskId();
    ask.timeoutMs = ask.timeoutMs ?? this.cfg.timeout.skillAskMs;
    // 被询问者缺省为技能所有者（playerId）；「依次自选」类技能经 ask.askPlayerId 依次问其他人
    this.pendingAsk = { ask, playerId: ask.askPlayerId ?? playerId, kind: entry ? 'hook' : 'cutIn', entry, hookName, args, resume };
  }

  private newAskId(): string {
    return `ask-${++this.askSeq}`;
  }

  private finishSkillAction(playerId: string): void {
    const mods = this.pendingMods.get(playerId);
    if (mods?.endTurn) {
      delete mods.endTurn;
      if (Object.keys(mods).length === 0) this.pendingMods.delete(playerId);
      if (this.phase === 'playing') {
        if (this.tableCombo) {
          // 换牌类技能取代出牌阶段，按过牌推进：其余人全过 → 轮末最后出牌者摸 1 张并起新回合
          this.passCount++;
          if (this.passCount >= this.activeCount() - 1) this.endRound();
          else this.advanceTurn();
        } else {
          // 无桌面牌（起牌者的 myTurn 技能）：仅换轮
          this.advanceTurn();
        }
      }
    }
  }

  // ---------- 工具 ----------

  /** 桌面一手牌归属改写（阿色再问/惰戈亢奋：视作由新 owner 打出）。
   *  轮转从新 owner 的下家继续（原打出者不跳过）；轮末无人再接则新 owner 获得牌权；
   *  这手牌触发的后续技能判定一律对新 owner 生效。 */
  private attributeTable(ownerId: string): void {
    if (!this.tableCombo || this.tableOwnerId === ownerId) return;
    const from = this.tableOwnerId;
    this.tableOwnerId = ownerId;
    this.roundLastPlayerId = ownerId;
    this.turnPlayerId = ownerId; // 之后 advanceTurn 从其下家开始轮转
    this.emit({ type: 'table:attributed', playerId: ownerId, fromPlayerId: from, combo: this.tableCombo });
  }

  /** 明置一张手牌到桌旁（再问补打：随当前一手牌一起进弃牌堆） */
  private playSideCard(playerId: string, cardId: number): void {
    const hand = this.hands.get(playerId);
    if (!hand) return;
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx < 0) return;
    const [card] = hand.splice(idx, 1);
    this.tableSide.push(card!);
    this.emit({ type: 'table:side', playerId, card: card! });
  }

  private nextSeat(id: string, skip = 0): string {
    const idx = this.players.findIndex((p) => p.id === id);
    let cur = idx;
    for (let s = 0; s <= skip; s++) {
      do {
        cur = (cur + 1) % this.players.length;
      } while (this.eliminated.has(this.players[cur]!.id));
    }
    return this.players[cur]!.id;
  }

  /** 起牌死锁守卫：可起牌的合法组合（beforePlay 干跑否决计为不可起） */
  private legalLeadCombos(playerId: string): Combo[] {
    return this.playableNotVetoed(
      playerId,
      listPlayable(this.hands.get(playerId)!, null, this.cfg, this.orderReversed(), this.soloJokerAllowed(playerId))
    );
  }

  /** 可合法响应的组合：基础可管且未被 beforePlay 干跑否决（技能否决后允许过） */
  private legalResponses(playerId: string): Combo[] {
    // 响应限制（抽你）：非指定玩家视为无牌可管（允许过）
    if (this.tableResponderRestrict && playerId !== this.tableResponderRestrict) return [];
    return this.playableNotVetoed(
      playerId,
      listPlayable(
        this.hands.get(playerId)!,
        this.tableCombo,
        this.cfg,
        this.orderReversed(),
        this.soloJokerAllowed(playerId)
      )
    );
  }

  /** 过滤被 beforePlay 干跑否决的组合（干跑：ask 不挂起、modify 不生效、播报不落） */
  private playableNotVetoed(playerId: string, combos: Combo[]): Combo[] {
    return combos.filter((combo) => {
      for (const entry of this.orderedHooks('beforePlay')) {
        const r = this.runHook(entry, [{ combo, table: this.tableCombo }], { dryRun: true });
        if (r.vetoed) return false;
      }
      return true;
    });
  }

  private emit(e: GameEventData): void {
    this.pendingEvents.push({ seq: this.seq++, ...e });
  }

  private ok(): ActionResult {
    if (this.revealedPool.length > 0 && !this.pendingAsk) throw new Error('翻牌池未清空（角色技能泄漏）');
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return { ok: true, events, suspended: !!this.pendingAsk, pendingAsk: this.pendingAsk?.ask };
  }

  /** 挂起：不排空事件（全部留到最终恢复后一起广播，保证顺序） */
  private suspendedOk(): ActionResult {
    return { ok: true, events: [], suspended: true, pendingAsk: this.pendingAsk?.ask };
  }

  private beatFailReason(combo: Combo, finishSpecial = false): string {
    if (finishSpecial) return this.orderReversed() ? '不能以单 3/对 3 打完手牌（倒序禁止收尾）' : '不能以单 2/对 2 打完手牌';
    const rev = this.orderReversed();
    const t = this.tableCombo!;
    if (t.type === 'singleJoker') return '只有炸弹能压住王（橐驼诅咒：单王点数无穷）';
    if (t.type === 'jokerPair') return '只有炸弹能压住对王（橐驼诅咒：对王压一切对子）';
    if (t.type === 'bomb') {
      if (combo.type !== 'bomb') return '只有炸弹能压住炸弹';
      return rev ? '炸弹张数或点数不够大（倒序同张数比点相反）' : '炸弹张数或点数不够大';
    }
    if (combo.type === 'single' || combo.type === 'pair') {
      if (t.rank === (rev ? RANK_3 : RANK_2)) return rev ? '只有炸弹能压住 3' : '只有炸弹能压住 2';
      return rev ? '必须恰好小一级（只有 3 可以无视）' : '必须恰好大一级（只有 2 可以无视）';
    }
    if (combo.length !== t.length) return '牌型长度必须相同';
    if (combo.rank <= t.rank) return rev ? '接牌最高点必须比上家更高（倒序）' : '起点必须比上家更大';
    return '接牌的起点必须落在上家牌型的点数范围内';
  }
}

const fail = (reason: string): ActionResult => ({ ok: false, reason });
