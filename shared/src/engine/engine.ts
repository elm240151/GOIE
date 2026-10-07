// 游戏引擎：状态机 + 回合/轮循环 + 角色钩子分发 + 事件。
// 原则：
// - 服务端权威，客户端只渲染
// - 所有随机走注入 RNG（可复现）
// - 技能优先：每个判定点 = 基础规则校验 → 角色钩子覆写（allowAnyway 放行 / ok:false 否决）
// - 角色只能通过 EngineFacade + ActionMods 有界改牌，无法破坏引擎不变量
// - 技能询问：钩子可返回 ask 挂起动作，服务端询问玩家后 resolveAsk 重跑提问钩子（钩子须纯：返回 ask 前不得改状态）
import { JOKER_BIG, RANK_2, RANK_3, RANK_A, SUITS, isJoker, isRank, pointValue, rankLabel, type Card, type Rank } from '../cards';
import { type RuleConfig } from '../config';
import { canBeat, exactFollows, isExactFollow, listPlayable, ouYaCovers, parseCombo, relabelCombo, validateFlipResponse, yaoWuCovers, type Combo } from './combos';
import { buildDeck, shuffle } from './deck';
import { type GameEvent, type GameEventData } from './events';
import { type Rng } from './rng';
import { type GameSnapshot } from './snapshot';
import {
  type ActionMods,
  type AskAnswer,
  type DevCardSpec,
  type EngineFacade,
  type HeldGroup,
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
  /** 自定义摸牌（Elm 开发者账号）：开局即开启换牌询问的玩家 id */
  devDrawPlayerIds?: string[];
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
  /** 内部调度标签：'hook' = 重跑提问钩子；'cutIn' = 插队；'pancake' = 吐饼多阶段；'proxyPlay' = 讲题代打；
   *  'engine' = 引擎级询问（神秘初始手牌/摸牌 1-2 选择），不走钩子重跑 */
  kind: 'hook' | 'cutIn' | 'pancake' | 'proxyPlay' | 'engine';
  entry: HookEntry | null;
  hookName: keyof RoleHooks | null;
  args: unknown[];
  /** 恢复执行（带答案重跑钩子后的续跑逻辑） */
  resume: (outcome: HookOutcome) => void;
  /** kind='engine' 时的答复处理（直接拿 AskAnswer，不经钩子） */
  onResolve?: (answer: AskAnswer) => void;
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
  /** 端庄（轴承）翻面：桌旁展示的翻面牌 id（渲染为牌背；随当前一手牌一起进弃牌堆） */
  private tableSideHidden: number[] = [];
  /** 弃牌暂存区（2026-10-06 用户规则）：本回合（轮）内公开弃置的牌，全场可见；轮末随桌面牌一起进弃牌堆 */
  private stagedDiscards: { playerId: string; cards: Card[] }[] = [];
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
  /** 见习（陈正）：本回合罚站不得出牌的玩家——出牌被拒、不能被技能选为目标；自己的技能仍可用（回合结束清除） */
  private roundBanned = new Set<string>();
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
  /** 亢奋（惰戈，RoleDef.exciteOnPlay）：点数和 ≥20 的手牌打出那一刻归属改写的角色 */
  private exciteOwners = new Set<string>();
  /** 吐饼（R.F）：各玩家倒置成饼的牌——牌背朝上永久留桌，公开张数、牌面对所有人（含自己）不可见；
   *  不参与弃牌/摸回，任何技能不可拿回或弃置；饼数 ≥ 手牌数立即获胜（胜利判定在每次吃饼结算后） */
  private pancakes = new Map<string, Card[]>();
  /** 吐饼（R.F）：吃饼后的轮末起牌权（无人再接由其起牌；有人接上/新一轮开始即清除） */
  private provisionalLeadId: string | null = null;
  /** 吐饼（R.F）：本手已吃饼的玩家——响应轮转到他时不能过（只能打 2/炸弹，没有则自动过）；换手/换轮清除 */
  private pancakeNoPassId: string | null = null;
  /** 吐饼（R.F）多阶段：0 = 确认询问挂起；1 = 已同意、待自选一组恰好牌亮出；2 = 已亮牌摸牌、待自选倒置成饼 */
  private pancakeStage = 0;
  /** 吐饼（R.F）：本手吃饼应倒置的张数（= 实际摸到的张数 min(N, 牌堆)，阶段 2 校验用） */
  private pancakeFlipCount = 0;
  /** 温柔（组长）：本回合的「宝贝」成员——不得响应组长的出牌（压牌/插队/吃饼等）；轮末清空 */
  private babies = new Set<string>();
  /** 温柔（组长）：宝贝禁响应的基准——桌面这手牌归组长所有时生效（与 tableOwnerId 比较） */
  private babyOwnerId: string | null = null;
  /** 尖叫（苗条）：各玩家扣置的范文/尖叫鸡牌（牌背公开张数、只有苗条可见牌面；可发给打出者、可收回） */
  private held = new Map<string, HeldGroup[]>();
  /** 当前桌面一手牌的实际打出者（归属改写前）——尖叫（苗条）发牌给实际打出者：打光手牌的人摸回扣置牌后才能避免获胜 */
  private lastPlayPhysicalId: string | null = null;
  /** 神秘（辛歼）：独立牌堆（54 张一整副，id 独立于公共三副；摸空时独立弃牌堆洗回） */
  private privateDeck: Card[] = [];
  /** 神秘（辛歼）：独立弃牌堆（含他牌面 id 的一切弃置都进这里，不参与公共洗回） */
  private privateDiscard: Card[] = [];
  /** 神秘（辛歼）：独立牌堆的牌 id 集合（弃置按牌面 id 路由进独立弃牌堆） */
  private privateCardIds = new Set<number>();
  /** 神秘（辛歼）玩家 id（房间至多一人） */
  private mysticPlayerId: string | null = null;
  /** 障目（辛歼）门控状态：key = 'casterId:skillId'。pending = 猜牌/摸牌阶段中；passed = 本回合已猜中通过；
   *  blocked = 本回合已猜错（不能对其他人发动，对辛歼重试可再猜） */
  private zhangMuPending = new Map<string, 'guess' | 'draw'>();
  private zhangMuPassed = new Set<string>();
  private zhangMuBlocked = new Set<string>();
  /** 障目延迟摸牌挂账（2026-10-07 用户反馈）：技能先生效、摸 1-3 延后到动作收尾兑现 */
  private zhangMuDrawQueue: number[] = [];
  /** 自定义摸牌（Elm 开发者账号，2026-10-07）：开关开启的玩家——摸牌照常随机，动作收尾逐张询问换牌 */
  private devDrawOn = new Set<string>();
  /** 自定义摸牌待换牌记录：玩家 → 刚摸到的牌（含各自来源堆，逐张换完后清空） */
  private devPending = new Map<string, { cards: { card: Card; source: 'deck' | 'private' }[]; swapIndex: number }>();
  /** 当前正在运行的钩子条目（zhangMuCheck 续跑 applyOutcome 用） */
  private runningEntry: HookEntry | null = null;

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
      if (this.roles.get(p.roleId)?.exciteOnPlay) this.exciteOwners.add(p.id);
    }
    // 自定义摸牌（Elm 开发者账号）：开局即开启的玩家
    for (const id of opts.devDrawPlayerIds ?? []) this.devDrawOn.add(id);
    // 神秘（辛歼）：独立牌堆 = 一整副 54 张，id 接在公共三副之后（162..215）、deck 字段 3
    const mystic = players.find((p) => this.roles.get(p.roleId)?.mystic);
    if (mystic) {
      this.mysticPlayerId = mystic.id;
      this.privateDeck = shuffle(
        buildDeck(1).map((c, i) => ({ ...c, id: 162 + i, deck: 3 })),
        this.rng
      );
      for (const c of this.privateDeck) this.privateCardIds.add(c.id);
    }
  }

  // ---------- 对外接口 ----------

  /** 开局：发牌（辛歼先问初始手牌数）→ 角色 setup → onDeal 钩子 → 进入第一轮 */
  start(): void {
    if (this.phase !== 'dealing') return;
    for (const p of this.players) this.hands.set(p.id, []);
    if (this.handsOverride) {
      this.applyHandsOverride();
    } else {
      this.deck = shuffle(buildDeck(this.cfg.deck.count), this.rng);
      for (const p of this.players) {
        // 神秘（辛歼）：初始手牌数自选（先手 5-7、其他 4-6），挂起询问后再发
        if (p.id === this.mysticPlayerId) continue;
        // 贪婪（阿摩）：初始手牌 = 2×全场人数张（先手/后手同，不沿用「先手多 1」）
        const n = this.roles.get(p.roleId)?.greedy
          ? this.players.length * 2
          : p.id === this.startPlayerId
            ? this.cfg.deal.leaderCards
            : this.cfg.deal.others;
        this.rawDraw(p.id, n); // 两倍（玊）：发牌 ×2（先手 6×2=12、其余 5×2=10）在 rawDraw 内统一处理
      }
    }
    if (this.mysticPlayerId && !this.handsOverride) {
      // 神秘（辛歼）：开局询问初始手牌数（超时取正常张数——先手 6/其他 5）
      const isLeader = this.mysticPlayerId === this.startPlayerId;
      this.suspendEngine(
        this.mysticPlayerId,
        {
          kind: 'choice',
          prompt: '【神秘】选择你的初始手牌数',
          options: isLeader ? ['6 张', '5 张', '7 张'] : ['5 张', '4 张', '6 张'],
          declineAllowed: false,
        },
        (answer) => {
          const n = Number.parseInt(answer.choice ?? '', 10) || (isLeader ? 6 : 5);
          this.rawDraw(this.mysticPlayerId!, n);
          this.finishStart();
        }
      );
      return;
    }
    // 自定义摸牌（Elm 开发者账号）：发牌后逐张询问换牌，全部答完再收尾开局
    if (this.startDevSwapAsk(() => this.finishStart())) return;
    this.finishStart();
  }

  /** 发牌完成后的开局收尾：角色 setup → onDeal 钩子 → 进入第一轮 */
  private finishStart(): void {
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
    this.checkYaoWu(); // 耀武（阿摩）：发牌时就满足 → 立即获胜（phase 已置 playing，rawDraw 内的检查在发牌期跳过）
    if (this.phase !== 'playing') return;
    this.startRound(this.startPlayerId);
  }

  /** 出牌（基础规则校验 → beforePlay 钩子覆写 → 执行 → afterPlay/打断钩子）；flippedCardId = 端庄翻面（轴承） */
  playCards(playerId: string, cardIds: number[], flippedCardId?: number): ActionResult {
    if (this.phase !== 'playing') return fail('游戏已结束');
    if (this.pendingAsk) return fail('等待技能响应');
    if (playerId !== this.turnPlayerId) return fail('不是你的回合');
    // 统一出牌门控：禁打（罚站/诅咒，血压豁免）→ 抽你响应限制 → 宝贝守卫（温柔）；
    // 讲题（硝烟）发动门控复用同一口径——「让人替他出牌本质是硝烟出牌」（2026-10-06 用户确认）
    const gate = this.playGateBlocked(playerId);
    if (gate) return fail(gate);
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
    if (flippedCardId !== undefined) return this.playFlipResponse(playerId, cards, flippedCardId, rev);
    const combo = parseCombo(cards, this.cfg, rev, this.soloJokerAllowed(playerId));
    if (!combo) return fail('这不是合法牌型（王不能单独打出）');
    const baseLegal = canBeat(combo, this.tableCombo, this.cfg, rev);
    // 呕哑（玊）：接牌时可打出包含桌面全部实际点数的任意合法牌型，无视管牌规则（单王/对王桌面不可发动）
    const role = this.players.find((p) => p.id === playerId);
    const ouYaLegal = !!role && !!this.roles.get(role.roleId)?.ouYa && ouYaCovers(combo, this.tableCombo);
    // 留 X 禁止收尾：以单 2/对 2（倒序：单 3/对 3）打完手牌 → 拒绝（技能优先：钩子可 allowAnyway 放行；
    // 辛歼【神秘】豁免）
    const finishSpecial =
      !this.liu2ExemptFor(playerId) &&
      cards.length === hand.length &&
      (combo.type === 'single' || combo.type === 'pair') &&
      combo.rank === (rev ? RANK_3 : RANK_2);
    // 吐饼（R.F）无牌权限制：响应他人时只能直接打 2（正序单2/对2、倒序镜像单3/对3）或炸弹，
    // 其余恰好接上的普通牌只能靠吃饼；有牌权（领出/桌面归属自己）不受限
    if (
      baseLegal &&
      role &&
      this.roles.get(role.roleId)?.pancake &&
      this.tableCombo &&
      this.tableOwnerId !== playerId &&
      combo.type !== 'bomb' &&
      !((combo.type === 'single' || combo.type === 'pair') && combo.rank === (rev ? RANK_3 : RANK_2))
    ) {
      return fail(
        rev ? '【吐饼】无牌权时只能打出 3 或炸弹（其余恰好接上的牌请用吃饼）' : '【吐饼】无牌权时只能打出 2 或炸弹（其余恰好接上的牌请用吃饼）'
      );
    }
    return this.runBeforePlayHooks(playerId, combo, (baseLegal || ouYaLegal) && !finishSpecial, 0, false, finishSpecial);
  }

  /** 端庄（轴承）翻面接牌：翻面一张桌面牌后按规则响应（合法剩余走正常管牌、非法剩余走后继或炸弹） */
  private playFlipResponse(playerId: string, cards: Card[], flippedCardId: number, rev: boolean): ActionResult {
    const myRole = this.roles.get(this.players.find((p) => p.id === playerId)!.roleId);
    if (!myRole?.canFlipResponse) return fail('你没有【端庄】技能');
    const hand = this.hands.get(playerId)!;
    const res = validateFlipResponse(
      this.tableCombo,
      this.prevTableCombo,
      flippedCardId,
      cards,
      this.cfg,
      rev,
      this.soloJokerAllowed(playerId)
    );
    if (!res.ok) return fail(res.reason);
    // 留 X 禁止收尾同样适用于翻面接牌（后继 gap 牌型免于此限：多点数无法判定收尾；辛歼【神秘】豁免）
    const finishSpecial =
      !this.liu2ExemptFor(playerId) &&
      cards.length === hand.length &&
      (res.combo.type === 'single' || res.combo.type === 'pair') &&
      res.combo.rank === (rev ? RANK_3 : RANK_2);
    return this.runBeforePlayHooks(
      playerId,
      res.combo,
      !finishSpecial,
      0,
      false,
      finishSpecial,
      (pid, combo) => this.commitFlipPlay(pid, combo, flippedCardId, res.pressedKind)
    );
  }

  /** 过牌 */
  pass(playerId: string): ActionResult {
    if (this.phase !== 'playing') return fail('游戏已结束');
    if (this.pendingAsk) return fail('等待技能响应');
    if (playerId !== this.turnPlayerId) return fail('不是你的回合');
    if (this.tableCombo === null) return fail('新一轮起牌者必须出牌');
    // 吐饼（R.F）：吃过饼后同一手轮到自己不能再过——只能打 2（倒序 3）/炸弹；两者都没有时 beginTurn 已自动过
    if (this.pancakeNoPassId === playerId && this.restrictedFollows(playerId).length > 0) {
      return fail(
        this.orderReversed() ? '【吐饼】吃过饼后不能过牌（只能打出 3 或炸弹）' : '【吐饼】吃过饼后不能过牌（只能打出 2 或炸弹）'
      );
    }
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
    // 吐饼（R.F）：过牌钩子结算后立即判定获胜（2026-10-06 用户定稿）
    if (this.checkPancakeWin()) return this.ok();
    // 空手获胜：手牌+扣置全空 → 立即判胜（同上口径，2026-10-06 用户定稿）
    if (this.checkEmptyHandWin()) return this.ok();
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
    const role = this.roles.get(this.players.find((p) => p.id === playerId)!.roleId);
    const action = role?.skillActions?.find((a) => a.skillId === req.skillId);
    if (!role || !action) return fail('技能不存在');
    // anyTime（尖叫收回扣置牌等）：不受「轮到出牌」限制，随时可用（有挂起询问时除外）
    if (!action.anyTime && playerId !== this.turnPlayerId) return fail('不是你的回合');
    if (action.when === 'following' && !this.tableCombo) return fail('现在不能发动该技能');
    // 见习/反力矩（陈正）：只有拥有牌权（本回合起牌者）时才能发动
    if (action.onlyWhenLeader && this.roundLeaderId !== playerId) return fail('只有拥有牌权（起牌回合）时才能发动');
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
    const p = this.pendingAsk;
    if (!p) return fail('没有待处理的技能询问');
    // 引擎级询问（神秘初始手牌等）在发牌期即可作答
    if (this.phase !== 'playing' && p.kind !== 'engine') return fail('游戏已结束');
    if (p.playerId !== playerId) return fail('不是你的技能询问');
    if (p.ask.askId !== answer.askId) return fail('询问已失效');
    this.pendingAsk = null;
    // 引擎级询问：直接交给答复处理（神秘初始手牌/摸牌 1-2 等，不走钩子重跑）
    if (p.kind === 'engine') {
      p.onResolve?.(this.effectiveAnswer(p.ask, answer));
      return this.ok();
    }
    // suspend() 会把 PendingAsk.kind 设为 'hook'/'cutIn'/'pancake'/'proxyPlay'（内部调度标签），此处须看 ask.kind
    if (p.ask.kind === 'selfFollow') {
      return this.resolveSelfFollow(playerId, answer);
    }
    if (p.kind === 'proxyPlay') return this.resolveProxyPlay(playerId, answer, p);
    if (p.kind === 'pancake') return this.resolvePancake(playerId, answer);
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
      // 留 X 禁止收尾：插队同样不能以单 2/对 2（倒序单 3/对 3）打完手牌（辛歼【神秘】豁免）
      if (
        !this.liu2ExemptFor(playerId) &&
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
    // 不可弃权询问（declineAllowed: false）：弃权（含超时自动弃权、客户端旧版强发）按默认作答，
    // 保证技能效果不被跳过（2026-10-06 用户确认：对别人产生的效果不能弃权）
    const outcome = this.runHook(p.entry!, p.args, { answer: this.effectiveAnswer(p.ask, answer) });
    p.resume(outcome);
    return this.ok();
  }

  /** 不可弃权询问的默认作答：choice/suit 取第一项，pickCards 取最前的牌（张数取 min） */
  private effectiveAnswer(ask: SkillAsk, answer: AskAnswer): AskAnswer {
    if (answer.choice !== 'decline' || ask.declineAllowed !== false) return answer;
    if ((ask.kind === 'choice' || ask.kind === 'suit') && ask.options?.[0]) {
      return { ...answer, choice: ask.options[0] };
    }
    if (ask.kind === 'pickCards' && ask.cards?.length) {
      const n = Math.max(ask.min ?? 1, 1);
      // 清除 choice='decline'：角色钩子多以 a.choice === 'decline' 提前返回（如法音），
      // 保留会绕过「自动弃第一张」的默认作答
      return { ...answer, choice: undefined, cardIds: ask.cards.slice(0, n).map((c) => c.id) };
    }
    return answer;
  }

  /** 真实终局判定（dealing 期快照会报 finished——房间判终局/计分必须看这里，不能用快照 phase） */
  get isFinished(): boolean {
    return this.phase === 'finished';
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
        // 神秘（辛歼）：手牌数不可探查——对其他玩家发 -1（客户端显示 ??）
        handCount:
          p.id !== viewerId && p.id === this.mysticPlayerId
            ? -1
            : this.hands.get(p.id)?.length ?? 0,
        hand: p.id === viewerId ? [...(this.hands.get(p.id) ?? [])] : null,
        connected: true,
        eliminated: this.eliminated.has(p.id),
        roleState: this.roleStates.get(p.id),
        /** 吐饼（R.F）：倒置成饼的张数（公开张数、牌面对所有人不可见） */
        pancakeCount: this.pancakes.get(p.id)?.length ?? 0,
        /** 尖叫（苗条）：扣置张数（公开张数；牌面只对苗条自己可见） */
        heldCount: (this.held.get(p.id) ?? []).reduce((s, g) => s + g.cards.length, 0),
        held: p.id === viewerId ? (this.held.get(p.id) ?? []).map((g) => ({ kind: g.kind, cards: [...g.cards] })) : null,
        /** 尖叫（苗条）：扣置组公开信息（类型 + 张数所有人可见；牌面只对苗条自己可见） */
        heldGroups: (this.held.get(p.id) ?? []).map((g) => ({ kind: g.kind, count: g.cards.length })),
      })),
      /** 温柔（组长）：本回合被标为「宝贝」的玩家（不得响应组长的出牌；界面展示标记） */
      babyIds: [...this.babies],
      /** 标宝贝者（组长本人）；宝贝响应桌面牌时与 tableOwnerId 同值即被拒（客户端预览门控用） */
      babyOwnerId: this.babyOwnerId,
      /** 血压（硝烟）：受高血压保护的玩家（手牌 ≥8，其余人的技能不能对其生效；界面展示标记） */
      bpProtectedIds: this.players.filter((p) => this.bpProtected(p.id)).map((p) => p.id),
      deckCount: this.deck.length,
      discardCount: this.discarded.length,
      /** 神秘（辛歼）：独立牌堆/弃牌堆张数只对自己可见 */
      privateDeckCount: viewerId === this.mysticPlayerId ? this.privateDeck.length : null,
      privateDiscardCount: viewerId === this.mysticPlayerId ? this.privateDiscard.length : null,
      /** 翻牌展示区：判定牌公开，所有人都能看（角色须在动作内清空） */
      revealed: [...this.revealedPool],
      table: this.tableCombo,
      /** 桌面一手牌的归属者（含亢奋/再问归属改写；起牌前为 null；客户端宝贝预览门控用） */
      tableOwnerId: this.tableOwnerId === '' ? null : this.tableOwnerId,
      /** 端庄（轴承）翻面：预览与正常出牌共用（情况一接上一手用） */
      prevTable: this.prevTableCombo,
      tableSide: [...this.tableSide],
      /** 端庄（轴承）翻面：桌旁牌背展示的翻面牌 id */
      tableSideHidden: [...this.tableSideHidden],
      /** 弃牌暂存区：本回合公开弃置的牌（轮末进弃牌堆） */
      stagedDiscards: this.stagedDiscards.map((e) => ({ playerId: e.playerId, cards: [...e.cards] })),
      orderReversed: this.orderReversed(),
      tableRankNote: this.tableRankNote,
      /** 红楼梦（地坛）：被诅咒（含下一轮生效中）的玩家，界面展示标记 */
      cursedPlayerIds: [...new Set([...this.activeBan, ...this.pendingBan.keys()])],
      /** 见习（陈正）：本回合罚站不得出牌的玩家，界面展示标记 */
      roundBannedIds: [...this.roundBanned],
      /** 吐饼（R.F）：本手吃过饼、轮到自己且不能过（只能打 2/炸弹——客户端禁用「过」并提示） */
      pancakeNoPass:
        viewerId === this.turnPlayerId &&
        this.pancakeNoPassId === viewerId &&
        this.restrictedFollows(viewerId).length > 0,
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

  /** 两倍（玊）：该玩家的发牌/摸牌/手牌上限均翻倍 */
  private doubleSupplyFor(playerId: string): boolean {
    const p = this.players.find((x) => x.id === playerId);
    return !!p && !!this.roles.get(p.roleId)?.doubleSupply;
  }

  /** 神秘（辛歼）：留 2 豁免——可以以单 2/对 2（倒序单 3/对 3）打完手牌（含代打/翻面接等一切路径） */
  private liu2ExemptFor(playerId: string): boolean {
    const p = this.players.find((x) => x.id === playerId);
    return !!p && !!this.roles.get(p.roleId)?.mystic;
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
      if (this.tableCombo) this.discardCards([...this.tableCombo.cards, ...this.tableSide]);
      // 弃牌暂存区（2026-10-06 用户规则）：轮末与桌面牌一起进弃牌堆
      for (const e of this.stagedDiscards) this.discardCards(e.cards);
      this.stagedDiscards = [];
      this.tableCombo = null;
      this.tableSide = [];
      this.tableSideHidden = [];
      this.tableRankNote = null;
      this.tableOwnerId = '';
      this.lastPlayPhysicalId = null;
      this.tableResponderRestrict = null;
      this.prevTableOwnerId = null;
      this.prevTableSuits = new Set();
      this.prevTableCombo = null;
      this.passCount = 0;
      this.roundLastPlayerId = null;
      this.provisionalLeadId = null;
      this.pancakeNoPassId = null;
      this.roundLeaderId = leaderId;
      this.aftermathMode = 'normal';
      this.cutInVictimId = null;
      this.roundBanned.clear(); // 见习（陈正）罚站：只持续本回合，新一轮开始解除
      this.babies.clear(); // 温柔（组长）：宝贝只持续本回合，新一轮开始解除
      this.babyOwnerId = null;
      this.zhangMuPending.clear(); // 障目（辛歼）：门控状态只持续本回合
      this.zhangMuPassed.clear();
      this.zhangMuBlocked.clear();
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
    // 吐饼（R.F）：回合开始钩子（反力矩被动等）结算后立即判定获胜（2026-10-06 用户定稿）
    if (this.checkPancakeWin()) return;
    // 空手获胜：手牌+扣置全空 → 立即判胜（同上口径，2026-10-06 用户定稿）
    if (this.checkEmptyHandWin()) return;
    // 吐饼（R.F）：吃过饼后轮到自己且没有 2/炸弹可打 → 自动过（有的话出牌，过牌会被拒）
    const pancakeForcedPass = this.pancakeNoPassId === id && this.restrictedFollows(id).length === 0;
    // 强制过（技能效果）；红楼梦（地坛）禁出玩家同样轮到他自动过（血压保护者豁免禁打）。
    // 罚站（见习）不自动过：轮到其出牌但被拒，可过牌、可用自己的技能（2026-10-06 回归修复）
    if ((this.forcedPass.has(id) || this.activeBan.has(id)) && !this.bpProtected(id) || pancakeForcedPass) {
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

  /** 一轮结束：出牌者摸牌 → 继续起牌。吐饼（R.F）：吃饼者获得轮末起牌权（暂存），
   *  有人再接上时 commit 路径已清除暂存、按正常最后出牌者结算 */
  private endRound(): void {
    const lastId = this.provisionalLeadId ?? this.roundLastPlayerId!;
    this.provisionalLeadId = null;
    this.runRoundEndHooks(lastId, 0);
  }

  // ---------- 出牌流水线（挂起可恢复） ----------

  private runBeforePlayHooks(
    playerId: string,
    combo: Combo,
    baseLegal: boolean,
    index: number,
    allowAnyway: boolean,
    finishSpecial: boolean,
    commit: (pid: string, combo: Combo) => ActionResult = (pid, c) => this.commitPlay(pid, c)
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
            this.runBeforePlayHooks(playerId, combo, baseLegal, i + 1, nextAllow, finishSpecial, commit),
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
    return commit(playerId, combo);
  }

  /** 出牌执行（上一手被压的牌进弃牌堆）→ afterPlay → 打断钩子 → 获胜判定 */
  private commitPlay(playerId: string, combo: Combo, attrOwner?: string): ActionResult {
    // 讲题（硝烟）：attrOwner = 代打归属改写「视作其打出」——亢奋判定按归属者（其牌 ≥20 仍可再归惰戈），
    // 洄游等物理出牌者技能不触发；无 attrOwner 时亢奋按物理出牌者判定
    const effOwner = attrOwner ? (this.exciteOwnerFor(attrOwner, combo) ?? attrOwner) : this.exciteOwnerFor(playerId, combo);
    const flips = this.orderFlippers.has(effOwner ?? playerId);
    this.lastPlayOrderReversed = this.orderReversed(); // 洄游先判后切：本手按切换前顺序判定（巨石触发镜像用）
    if (flips) this.orderFlipCount++; // 洄游：物理出牌即切换（先判后切，本手按切换前顺序判定）
    this.removeCards(playerId, combo.cards);
    if (this.tableCombo) this.discardCards([...this.tableCombo.cards, ...this.tableSide]);
    this.tableSide = [];
    this.tableSideHidden = [];
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
    this.lastPlayPhysicalId = playerId; // 尖叫（苗条）：实际打出者（归属改写前）
    this.roundLastPlayerId = playerId;
    this.passCount = 0;
    this.provisionalLeadId = null; // 吐饼（R.F）：有人打出新牌，吃饼暂存的起牌权作废、牌权正常更迭
    this.pancakeNoPassId = null;
    this.lastPlayWasCutIn = false;
    this.emit({ type: 'cards:played', playerId, combo });
    if (effOwner) this.attributeTable(effOwner); // 归属惰戈：轮转从其下家、判定对其生效（发出 table:attributed）
    return this.runAfterPlayHooks(playerId, combo, 0);
  }

  /**
   * 端庄（轴承）翻面接牌执行：翻面牌留桌旁展示为牌背（tableSideHidden），被翻的手其余牌进弃牌堆。
   * 情况一（翻掉整手接上一手）：被压的人仍是上一手所有者（prevTable* 保持不变）；
   * 情况二（翻部分牌接剩余）：被压的人是本手所有者，花色/牌型取剩余牌。
   */
  private commitFlipPlay(
    playerId: string,
    combo: Combo,
    flippedCardId: number,
    pressedKind: 'top' | 'prev'
  ): ActionResult {
    const effOwner = this.exciteOwnerFor(playerId, combo); // 亢奋：翻面接同样适用（任何「打出」都算）
    const flips = this.orderFlippers.has(effOwner ?? playerId);
    this.lastPlayOrderReversed = this.orderReversed(); // 洄游先判后切：本手按切换前顺序判定
    if (flips) this.orderFlipCount++;
    this.removeCards(playerId, combo.cards);
    const flipped = this.tableCombo?.cards.find((c) => c.id === flippedCardId) ?? null;
    const remainder = (this.tableCombo?.cards ?? []).filter((c) => c.id !== flippedCardId);
    if (this.tableCombo) this.discardCards([...remainder, ...this.tableSide]);
    this.tableSide = flipped ? [flipped] : [];
    this.tableSideHidden = flipped ? [flippedCardId] : [];
    this.tableResponderRestrict = null;
    this.tableRankNote = null;
    this.tableCombo = combo;
    if (flips) this.resyncTableOrder(); // 洄游：切换后桌面按新牌序重新解析
    if (pressedKind === 'top') {
      this.prevTableOwnerId = this.tableOwnerId === '' ? null : this.tableOwnerId;
      this.prevTableSuits = new Set(remainder.filter((c) => !isJoker(c)).map((c) => c.suit));
      this.prevTableCombo =
        this.prevTableOwnerId == null
          ? null
          : (parseCombo(remainder, this.cfg, this.orderReversed(), true) ?? null);
    }
    this.tableOwnerId = playerId;
    this.lastPlayPhysicalId = playerId; // 尖叫（苗条）：翻面接也是打出，实际打出者同样记录
    this.roundLastPlayerId = playerId;
    this.passCount = 0;
    this.provisionalLeadId = null; // 吐饼（R.F）：同上，翻面接也是打出新牌
    this.pancakeNoPassId = null;
    this.lastPlayWasCutIn = false;
    this.emit({ type: 'cards:played', playerId, combo });
    if (effOwner) this.attributeTable(effOwner); // 亢奋：翻面接归属惰戈
    return this.runAfterPlayHooks(playerId, combo, 0);
  }

  private runAfterPlayHooks(playerId: string, combo: Combo, index: number): ActionResult {
    // 亡语门控（2026-10-05 用户定稿 + 2026-10-06 追加）：出牌者真正打完所有牌（手牌+扣置全空，
    // 出完即胜判定前——扣置牌也算手牌，实体手牌打光但扣置仍在不算空手，2026-10-06 苗条修正），
    // 或吐饼获胜条件已满足（饼数 ≥ 手牌数，宣判前不再触发别人的技能），或已有玩家空手待判胜
    // （手牌+扣置全空，法音弃置等路径），只有标注亡语（RoleDef.deathrattleHooks）的钩子可以触发；
    // 未标注的跳过——游戏直接结束
    const finishing =
      (!this.eliminated.has(playerId) && this.handHeldTotal(playerId) === 0) ||
      this.pancakeWinCandidate() !== null ||
      this.emptyHandWinCandidate() !== null;
    const hooks = this.orderedHooks('afterPlay');
    for (let i = index; i < hooks.length; i++) {
      const entry = hooks[i]!;
      if (finishing && !(entry.role.deathrattleHooks?.includes('afterPlay') ?? false)) continue;
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
    // 亡语门控（2026-10-05 用户定稿 + 2026-10-06 追加）：同上——打断钩子也是「打完牌以后」触发，
    // 出牌者真正打完所有牌（手牌+扣置全空）、吐饼获胜条件已满足（饼数 ≥ 手牌数）、或已有玩家
    // 空手待判胜（手牌+扣置全空）时，只有标注亡语的打断技能（旺旺/巨石/五连鞭/压腿）可以询问，
    // 非亡语（答疑等）不再触发
    const finishing =
      (!this.eliminated.has(playerId) && this.handHeldTotal(playerId) === 0) ||
      this.pancakeWinCandidate() !== null ||
      this.emptyHandWinCandidate() !== null;
    const hooks = this.orderedHooks('onPlayInterrupt');
    for (let i = index; i < hooks.length; i++) {
      const entry = hooks[i]!;
      if (finishing && !(entry.role.deathrattleHooks?.includes('onPlayInterrupt') ?? false)) continue;
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

  /** 无名加牌 X：响应牌（当前桌面）中与被压牌同花色的真牌点数总和（2 记 2、A 记 1，2026-10-06 用户确认）；0 = 无同花色 */
  private matchSuitDrawX(): number {
    return this.tableCombo!.cards
      .filter((c) => !isJoker(c) && this.prevTableSuits.has(c.suit))
      .reduce((s, c) => s + pointValue(c.rank), 0);
  }

  /** 出牌后的收尾：夺权 → 出完即胜/留2判负 → 吐饼问询（最先）→ 插队/无名加牌后续 → 插队问询/轮到下家 */
  /** 约等（煞蔱）：收回她刚打的一手牌（桌面回退上一手）→ 与目标均分手牌 → 从她下家继续接牌 */
  private yueDengRevert(ownerId: string, targetId: string): void {
    const nameOf = (id: string) => this.players.find((p) => p.id === id)?.name ?? id;
    // 收回刚压的那一手（桌旁边牌随弃）
    const hand = this.hands.get(ownerId) ?? [];
    hand.push(...(this.tableCombo?.cards ?? []));
    if (this.tableSide.length > 0) this.discardCards([...this.tableSide]);
    this.tableSide = [];
    this.tableSideHidden = [];
    this.tableCombo = this.prevTableCombo;
    this.tableOwnerId = this.prevTableOwnerId ?? '';
    // 被压的一手从弃牌堆移回桌面（commitPlay 已将其弃置；不移回会双重计数破坏守恒，2026-10-06 修复）
    if (this.prevTableCombo) {
      const restored = new Set(this.prevTableCombo.cards.map((c) => c.id));
      this.discarded = this.discarded.filter((c) => !restored.has(c.id));
      this.privateDiscard = this.privateDiscard.filter((c) => !restored.has(c.id));
    }
    this.prevTableCombo = null;
    this.prevTableOwnerId = null;
    this.prevTableSuits = new Set();
    this.tableRankNote = null;
    this.tableResponderRestrict = null;
    this.lastPlayPhysicalId = null;
    // 牌权仍归煞蔱（约等 = 该回合出了 0 张牌、牌权不转移）：下家接不上（全过）→ 轮末由煞蔱起牌
    // （2026-10-07 用户反馈：之前归回退那手牌的主人，做成了对面的牌权）
    this.roundLastPlayerId = ownerId;
    // 均分：合洗随机分，她拿 ⌊X/2⌋、对方拿其余（奇数时对方多 1）
    const other = this.hands.get(targetId) ?? [];
    const pool = shuffle([...hand, ...other], this.rng);
    const x = pool.length;
    const mine = Math.floor(x / 2);
    this.hands.set(ownerId, pool.slice(0, mine));
    this.hands.set(targetId, pool.slice(mine));
    this.checkHandLimit(ownerId);
    if (this.phase !== 'playing') return;
    this.checkHandLimit(targetId);
    if (this.phase !== 'playing') return;
    this.emit({
      type: 'skill:triggered',
      playerId: ownerId,
      roleId: 'sha-sha',
      skillId: 'yue-deng',
      text: `【约等】${nameOf(ownerId)} 收回刚打的手牌，与 ${nameOf(targetId)} 均分手牌（共 ${x} 张，${nameOf(ownerId)} 得 ${mine} 张），从其下家继续接牌`,
    });
    if (!this.tableCombo) {
      // 桌面空了（她收回的是起牌手）：她重新起牌
      this.startRound(ownerId);
      return;
    }
    this.passCount = 0;
    this.turnPlayerId = this.nextSeat(ownerId);
    this.beginTurn();
  }

  private afterPlayCommitted(playerId: string): ActionResult {
    // 夺权（巨石驱逐成功）：桌面作废，由技能所有者起牌
    for (const p of this.players) {
      const mods = this.pendingMods.get(p.id);
      if (mods?.seizeLead) {
        delete mods.seizeLead;
        if (Object.keys(mods).length === 0) this.pendingMods.delete(p.id);
        if (this.phase === 'playing') {
          if (this.tableCombo) this.discardCards([...this.tableCombo.cards]);
          this.tableCombo = null;
          this.tableRankNote = null;
          this.aftermathMode = 'normal';
          this.cutInVictimId = null;
          this.startRound(p.id);
        }
        return this.ok();
      }
    }
    // 约等（煞蔱）：收回她刚打的一手牌并均分——桌面回退上一手、从她下家继续接牌（非亡语，2026-10-06
    // 用户裁定：打光压出最后一手直接获胜、不再询问；正常路径在此获胜判定前消费）
    for (const p of this.players) {
      const mods = this.pendingMods.get(p.id);
      if (mods?.yueDeng) {
        const targetId = mods.yueDeng.targetId;
        delete mods.yueDeng;
        if (Object.keys(mods).length === 0) this.pendingMods.delete(p.id);
        if (this.phase === 'playing') this.yueDengRevert(p.id, targetId);
        return this.ok();
      }
    }
    // 出完即胜（被淘汰者不算）：谁打完谁赢——归属改写（再问）不改胜利判定，按物理出牌者判；
    // 留 X 禁止收尾已在出牌校验层拦截（单 2/对 2 打完手牌不可出），走到这里即为正常出完。
    // 别人打光手牌先于吃饼询问（R费拦不住）
    // 空手口径 = 手牌 + 扣置全空（扣置牌也算手牌——尖叫苗条：实体打光但扣置仍在时不算打完，
    // 苗条技照常摸牌，2026-10-06 用户修正）
    if (!this.eliminated.has(playerId) && this.handHeldTotal(playerId) === 0) {
      this.finishGame(playerId);
      return this.ok();
    }
    // 吐饼（R.F）：饼数 ≥ 手牌数 → 立即获胜（2026-10-06 用户定稿：不看来因——自己出牌/法音弃牌等任何
    // 致手牌减少的路径都触发；打断钩子含亡语已全部结算完，亡语先于获胜判定。全局扫描：他人技能致
    // R.F 手牌减少同样在此获胜）。
    if (this.checkPancakeWin()) return this.ok();
    // 空手获胜：手牌+扣置全空 → 不看来因立即判胜（法音弃置/给别人牌等路径；2026-10-06 用户定稿）。
    // 亡语已先结算（尖叫收回扣置后手牌非空则不满足）。
    if (this.checkEmptyHandWin()) return this.ok();
    // 贪婪（阿摩）：每次普通主动出牌后摸 1 张（从牌堆）。归属改写（亢奋：桌面视作惰戈打出）不摸；
    // 再问补打走 playSideCard 不经此流程；出完即胜已在上面先判（获胜不摸）。
    // 摸牌可能触发耀武立即获胜或超上限淘汰 → 终局则跳过后续询问。
    if (this.roles.get(this.players.find((p) => p.id === playerId)?.roleId ?? '')?.greedy && this.tableOwnerId === playerId) {
      const drawn = this.rawDraw(playerId, 1);
      if (drawn > 0 && this.phase === 'playing') this.emit({ type: 'cards:drawn', playerId, count: drawn });
      if (this.phase !== 'playing') return this.ok();
    }
    // 吐饼（R.F）：每次打出后最先问（先于狂吠/插队）；物理出牌者 ≠ R费（归属改写不改物理出牌者）
    const offer = this.offerPancake(playerId);
    if (offer) return offer;
    return this.afterPlayTail();
  }

  /** 出牌后的收尾尾部（吐饼询问恢复后从这里继续）：插队后续 → 无名加牌 → 狂吠问询 → 插队问询/轮到下家 */
  private afterPlayTail(): ActionResult {
    if (this.phase !== 'playing') return this.ok();
    const ownerId = this.roundLastPlayerId!;
    // 插队后续（无名）：受害者摸 X 张，轮转从无名的下家继续（插队跳过了中间的人）；
    // 归属改写（亢奋）：桌面视作惰戈打出 → 无名技能不触发（与普通响应分支同口径，2026-10-06 用户实机 bug）
    if (this.aftermathMode === 'cutIn') {
      this.aftermathMode = 'normal';
      const victimId = this.cutInVictimId!;
      this.cutInVictimId = null;
      const x = this.matchSuitDrawX();
      const owner = this.players.find((p) => p.id === ownerId);
      if (
        owner &&
        this.roles.get(owner.roleId)?.canCutIn &&
        x > 0 &&
        this.phase === 'playing' &&
        !this.eliminated.has(victimId) &&
        !this.bpProtected(victimId) // 血压（硝烟）：技能（含增益）不能对其生效
      ) {
        // 障目（辛歼）：指向性技能以辛歼为目标（被响应者）须先猜手牌数；猜错跳过加牌
        this.zhangMuGateRun(
          ownerId,
          victimId,
          'wu-ming',
          () => {
            this.drawCards(victimId, x);
            if (this.phase === 'playing') {
              this.turnPlayerId = this.nextSeat(ownerId);
              this.beginTurn();
            }
            return this.ok();
          },
          ownerId
        );
        return this.ok();
      }
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
      !this.bpProtected(this.prevTableOwnerId) && // 血压（硝烟）：技能（含增益）不能对其生效
      this.tableCombo
    ) {
      const owner = this.players.find((p) => p.id === ownerId);
      const x = this.matchSuitDrawX();
      if (owner && this.roles.get(owner.roleId)?.canCutIn && x > 0) {
        // 障目（辛歼）：指向性技能以辛歼为目标（被响应者）须先猜手牌数；猜错跳过加牌
        this.zhangMuGateRun(
          ownerId,
          this.prevTableOwnerId,
          'wu-ming',
          () => {
            this.drawCards(this.prevTableOwnerId!, x);
            if (this.phase !== 'playing') return this.ok();
            return this.afterPlayTailFollowups();
          },
          ownerId
        );
        return this.ok();
      }
    }
    return this.afterPlayTailFollowups();
  }

  /** 出牌后的收尾尾部（无名普通响应加牌后）：狂吠问询 → 插队问询/轮到下家 */
  private afterPlayTailFollowups(): ActionResult {
    if (this.phase !== 'playing') return this.ok();
    // 狂吠（修勾）：出牌者可以立刻压自己打出的牌，可连压到放弃/压不了（压完走完整流水线，狂吠可再次触发）
    const selfId = this.roundLastPlayerId!;
    if (
      this.tableCombo &&
      !this.eliminated.has(selfId) &&
      !this.playBanned(selfId) &&
      this.roles.get(this.players.find((p) => p.id === selfId)!.roleId)?.canSelfFollow &&
      listPlayable(
        this.hands.get(selfId)!,
        this.tableCombo,
        this.cfg,
        this.orderReversed(),
        this.soloJokerAllowed(selfId),
        this.liu2ExemptFor(selfId)
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

  // ---------- 吐饼（兰登·费夫 R.F）：特殊响应、不算出牌（2026-10-05 用户定稿） ----------

  /**
   * 蛋神（首席）压一切类打出：Q 压非 J 的单牌桌面没有「恰好」可接（与 2 压非 A 同源——
   * 自然接 J 的 Q 之后 K 仍可恰好接上）。按物理出牌者 + 上一手被压牌判定。
   */
  private tableIsSkywalkerQSpecial(): boolean {
    const t = this.tableCombo;
    if (!t || t.type !== 'single' || t.rank !== 12) return false; // 12 = Q
    const last = this.players.find((p) => p.id === this.roundLastPlayerId);
    if (!last || last.roleId !== 'skywalker') return false;
    return !(this.prevTableCombo && this.prevTableCombo.type === 'single' && this.prevTableCombo.rank === 11);
  }

  /**
   * 吐饼（R.F）无牌权时可直接打出的响应组合：2（正序单2/对2、倒序镜像单3/对3）或炸弹。
   * 响应限制（抽你）同样适用：非指定响应者视为无牌可打。
   */
  private restrictedFollows(playerId: string): Combo[] {
    if (this.tableCombo && this.tableResponderRestrict && playerId !== this.tableResponderRestrict) return [];
    const rev = this.orderReversed();
    const rk = rev ? RANK_3 : RANK_2;
    return listPlayable(
      this.hands.get(playerId)!,
      this.tableCombo,
      this.cfg,
      rev,
      this.soloJokerAllowed(playerId),
      this.liu2ExemptFor(playerId)
    ).filter((c) => c.type === 'bomb' || ((c.type === 'single' || c.type === 'pair') && c.rank === rk));
  }

  /** 吐饼问询：每次打出后最先问（先于狂吠/插队）。无 R费/无恰好接牌/特殊桌面/限制中 → 不挂起 */
  private offerPancake(physicalPlayerId: string): ActionResult | null {
    if (!this.tableCombo || this.pancakeStage !== 0) return null;
    if (this.tableIsSkywalkerQSpecial()) return null; // 首席 Q 压一切：没有「恰好」可接
    const rf = this.players.find(
      (p) =>
        this.roles.get(p.roleId)?.pancake &&
        !this.eliminated.has(p.id) &&
        !this.playBanned(p.id) &&
        p.id !== physicalPlayerId &&
        // 温柔（组长）：宝贝不得响应组长的出牌（吃饼算特殊响应，同样禁止）
        !(this.babies.has(p.id) && this.tableOwnerId === this.babyOwnerId) &&
        // 抽你限制适用：吃饼算响应，非指定响应者不能吃饼
        !(this.tableResponderRestrict && p.id !== this.tableResponderRestrict)
    );
    if (!rf) return null;
    const combos = exactFollows(
      this.hands.get(rf.id)!,
      this.tableCombo,
      this.cfg,
      this.orderReversed(),
      this.soloJokerAllowed(rf.id)
    );
    if (combos.length === 0) return null;
    this.suspend(
      rf.id,
      null,
      null,
      [],
      () => {},
      {
        kind: 'confirm',
        prompt: '【吐饼】恰好接得上，要前插吃饼吗？（吃饼 = 特殊响应、不算出牌：亮一组恰好接上的牌 → 从牌堆摸 N 张 → 倒置 N 张成饼；弃权则本手不再问）',
      },
      'pancake'
    );
    return this.suspendedOk();
  }

  /** 吐饼答案（多阶段）：确认 → 自选亮一组恰好牌 → 摸 N 张 → 自选 N 张倒置成饼 → 立即检查获胜 */
  private resolvePancake(playerId: string, answer: AskAnswer): ActionResult {
    const rf = playerId;
    // 吃饼询问只在有桌面时挂起（挂起期间无任何动作，桌面不会消失）
    const table = this.tableCombo!;
    const n = table.cards.length;
    if (this.pancakeStage === 0) {
      // 确认询问：弃权/超时 → 放弃本手（之后有人再出牌照常再问）
      if (answer.choice !== 'yes') {
        this.pancakeStage = 0;
        this.requeue(this.afterPlayTail());
        return this.ok();
      }
      this.pancakeStage = 1;
      return this.reaskPancakeCombo(rf);
    }
    if (this.pancakeStage === 1) {
      // 自选一组恰好接上的牌公开亮出（牌留在手中，不进饼）；非法选牌重新询问
      const hand = this.hands.get(rf)!;
      const cards: Card[] = [];
      for (const id of answer.cardIds ?? []) {
        const c = hand.find((x) => x.id === id);
        if (!c) return this.reaskPancakeCombo(rf, '手牌中没有这张牌');
        cards.push(c);
      }
      if (cards.length === 0) {
        // 超时/弃选：吃饼作废（尚未亮牌摸牌，无副作用）
        this.pancakeStage = 0;
        this.requeue(this.afterPlayTail());
        return this.ok();
      }
      const rev = this.orderReversed();
      const combo = parseCombo(cards, this.cfg, rev, this.soloJokerAllowed(rf));
      if (!combo || !canBeat(combo, table, this.cfg, rev) || !isExactFollow(combo, table, rev)) {
        return this.reaskPancakeCombo(rf, '必须选择恰好接上桌面的一组牌');
      }
      this.emit({ type: 'cards:revealed', playerId: rf, cards: combo.cards, purpose: '吐饼亮牌' });
      // 从牌堆摸 N 张（N = 桌面那手牌的张数；牌堆不足摸 min(N, 牌堆)；超手牌上限照常淘汰，淘汰即败）
      const drawn = this.rawDraw(rf, n);
      if (drawn > 0) this.emit({ type: 'cards:drawn', playerId: rf, count: drawn });
      if (this.phase !== 'playing' || this.eliminated.has(rf)) {
        this.pancakeStage = 0;
        this.requeue(this.afterPlayTail());
        return this.ok();
      }
      this.pancakeFlipCount = drawn;
      if (drawn === 0) return this.finishPancake(rf, []); // 没摸到牌：无饼可倒，直接结算
      this.pancakeStage = 2;
      this.suspend(
        rf,
        null,
        null,
        [],
        () => {},
        {
          kind: 'pickCards',
          cards: [...this.hands.get(rf)!],
          min: drawn,
          max: drawn,
          prompt: `【吐饼】选择 ${drawn} 张牌倒置成饼（牌背朝上、公开张数、永久留桌，牌面对所有人不可见）`,
        },
        'pancake'
      );
      return this.ok();
    }
    // 阶段 2：自选 N 张倒置成饼；超时/弃选 → 自动倒置前 N 张（已摸的牌不可退回，确定化兜底）
    const hand = this.hands.get(rf)!;
    const want = Math.min(this.pancakeFlipCount, hand.length);
    let cards: Card[] = [];
    for (const id of answer.cardIds ?? []) {
      const c = hand.find((x) => x.id === id);
      if (!c) return this.reaskPancakeFlip(rf, '手牌中没有这张牌');
      cards.push(c);
    }
    if (cards.length === 0) {
      cards = hand.slice(0, want); // 超时自动兜底：倒置手牌前 N 张
    } else if (cards.length !== want) {
      return this.reaskPancakeFlip(rf, `必须选择 ${want} 张牌倒置`);
    }
    return this.finishPancake(rf, cards);
  }

  /** 倒置成饼 → 牌权暂存 → 饼数 ≥ 手牌数立即获胜 → 恢复收尾尾部 */
  private finishPancake(rf: string, cards: Card[]): ActionResult {
    this.pancakeStage = 0;
    if (cards.length > 0) {
      this.removeCards(rf, cards);
      this.pancakes.set(rf, [...(this.pancakes.get(rf) ?? []), ...cards]);
      this.emit({ type: 'pancake:flipped', playerId: rf, count: cards.length });
      this.emit({
        type: 'skill:triggered',
        playerId: rf,
        roleId: 'rf',
        skillId: 'tu-bing',
        text: `【吐饼】${this.players.find((p) => p.id === rf)?.name ?? rf} 倒置 ${cards.length} 张成饼（共 ${this.pancakes.get(rf)!.length} 张）`,
      });
    }
    // 轮末牌权暂存给吃饼者（桌面归属不变）；吃过饼后本手轮到他不能再过
    this.provisionalLeadId = rf;
    this.pancakeNoPassId = rf;
    this.passCount = 0;
    // 吐饼（R.F）：饼数 ≥ 手牌数 → 立即获胜（统一判定，2026-10-06 用户定稿）
    if (this.checkPancakeWin()) return this.ok();
    // 空手获胜：手牌+扣置全空 → 立即判胜（同上口径，2026-10-06 用户定稿）
    if (this.checkEmptyHandWin()) return this.ok();
    this.requeue(this.afterPlayTail());
    return this.ok();
  }

  /** 非法亮牌：播报原因并重新询问（不消耗吃饼机会） */
  private reaskPancakeCombo(playerId: string, reason?: string): ActionResult {
    if (reason) this.emit({ type: 'game:error', playerId, reason });
    this.pancakeStage = 1;
    const cards = exactFollows(
      this.hands.get(playerId)!,
      this.tableCombo!,
      this.cfg,
      this.orderReversed(),
      this.soloJokerAllowed(playerId)
    ).flatMap((c) => c.cards);
    this.suspend(
      playerId,
      null,
      null,
      [],
      () => {},
      {
        kind: 'pickCards',
        cards,
        min: this.tableCombo!.cards.length,
        max: this.tableCombo!.cards.length,
        prompt: '【吐饼】自选一组恰好接上桌面的牌公开亮出（亮出的牌留在手中）',
      },
      'pancake'
    );
    return this.ok();
  }

  /** 非法倒置：播报原因并重新询问 */
  private reaskPancakeFlip(playerId: string, reason: string): ActionResult {
    this.emit({ type: 'game:error', playerId, reason });
    this.pancakeStage = 2;
    this.suspend(
      playerId,
      null,
      null,
      [],
      () => {},
      {
        kind: 'pickCards',
        cards: [...this.hands.get(playerId)!],
        min: this.pancakeFlipCount,
        max: this.pancakeFlipCount,
        prompt: `【吐饼】选择 ${this.pancakeFlipCount} 张牌倒置成饼（牌背朝上、公开张数、永久留桌，牌面对所有人不可见）`,
      },
      'pancake'
    );
    return this.ok();
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
    // 留 X 禁止收尾：狂吠同样不能以单 2/对 2（倒序单 3/对 3）打完手牌（辛歼【神秘】豁免）
    if (
      !this.liu2ExemptFor(playerId) &&
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
    const effOwner = this.exciteOwnerFor(playerId, combo); // 亢奋：狂吠连压同样适用
    const flips = this.orderFlippers.has(effOwner ?? playerId);
    this.lastPlayOrderReversed = this.orderReversed(); // 同上：狂吠连压也按切换前顺序判定
    if (flips) this.orderFlipCount++;
    this.removeCards(playerId, combo.cards);
    if (this.tableCombo) this.discardCards([...this.tableCombo.cards, ...this.tableSide]);
    this.tableSide = [];
    this.tableSideHidden = [];
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
    this.lastPlayPhysicalId = playerId; // 尖叫（苗条）：狂吠连压每一手都是打出，实际打出者同样记录
    this.roundLastPlayerId = playerId;
    this.passCount = 0;
    this.provisionalLeadId = null; // 吐饼（R.F）：狂吠连压同样打出新牌
    this.pancakeNoPassId = null;
    this.lastPlayWasCutIn = false;
    this.emit({ type: 'cards:played', playerId, combo });
    if (effOwner) this.attributeTable(effOwner); // 亢奋：狂吠连压归属惰戈
    return this.runAfterPlayHooks(playerId, combo, 0);
  }

  // ---------- 讲题（硝烟）代打 ----------

  /** 讲题（硝烟）代打提交：代打者选牌出牌（归属改写，视作硝烟打出）；弃权/超时 → 重跑硝烟钩子走惩罚分支 */
  private resolveProxyPlay(playerId: string, answer: AskAnswer, p: PendingAsk): ActionResult {
    const ownerId = p.entry!.playerId; // 讲题发起者（硝烟）——代打视作其打出
    // 讲题本质是硝烟出牌（2026-10-06 用户确认）：硝烟本人此刻被禁打/抽你限制/为宝贝 → 代打一并禁止
    // （正常流程讲题 stage-0 已门控，此处为防御：询问挂起期间门控状态变化的兜底）
    const ownerGate = this.playGateBlocked(ownerId);
    if (ownerGate) return this.reaskProxyPlay(p, ownerGate);
    if (answer.choice !== 'yes' || !answer.cardIds?.length) {
      // 未能打出：重跑硝烟钩子（带弃权答案），由其给出「令硝烟弃一张 / 代打者摸一张」惩罚选择
      const outcome = this.runHook(p.entry!, p.args, { answer });
      p.resume(outcome);
      return this.ok();
    }
    const hand = this.hands.get(playerId)!;
    const cards: Card[] = [];
    for (const id of answer.cardIds) {
      const c = hand.find((x) => x.id === id);
      if (!c) return this.reaskProxyPlay(p, '手牌中没有这张牌');
      cards.push(c);
    }
    const rev = this.orderReversed();
    const combo = parseCombo(cards, this.cfg, rev, this.soloJokerAllowed(playerId));
    if (!combo) return this.reaskProxyPlay(p, '这不是合法牌型');
    // 响应限制（抽你）：代打按正常管牌规则打——本回合只能由指定玩家响应
    if (this.tableCombo && this.tableResponderRestrict && playerId !== this.tableResponderRestrict) {
      return this.reaskProxyPlay(p, '【抽你】本回合只能由指定玩家响应');
    }
    // 温柔（组长）：宝贝代打同样不得响应组长的出牌（出牌类技能响应一并禁止）
    if (this.tableCombo && this.babies.has(playerId) && this.tableOwnerId === this.babyOwnerId) {
      return this.reaskProxyPlay(p, '【温柔】宝贝本回合不得响应组长的出牌');
    }
    const role = this.roles.get(this.players.find((x) => x.id === playerId)?.roleId ?? '');
    const baseLegal = this.tableCombo ? canBeat(combo, this.tableCombo, this.cfg, rev) : true;
    // 呕哑（玊）：代打者本人的技能同样可用（技能优先）
    const ouYaLegal = !!role?.ouYa && !!this.tableCombo && ouYaCovers(combo, this.tableCombo);
    // 留 X 禁止收尾：代打者同样不能以单 2/对 2（倒序单 3/对 3）打完自己的手牌（辛歼【神秘】豁免）
    const finishSpecial =
      !this.liu2ExemptFor(playerId) &&
      cards.length === hand.length &&
      (combo.type === 'single' || combo.type === 'pair') &&
      combo.rank === (rev ? RANK_3 : RANK_2);
    const r = this.runBeforePlayHooks(
      playerId,
      combo,
      (baseLegal || ouYaLegal) && !finishSpecial,
      0,
      false,
      finishSpecial,
      (pid, c) => this.commitPlay(pid, c, ownerId) // 视作硝烟打出：轮转/判定/牌权基准归硝烟
    );
    if (!r.ok) return this.reaskProxyPlay(p, r.reason ?? '不能打出这手牌');
    return r;
  }

  /** 讲题（硝烟）非法选牌：播报原因并重新询问代打者（可弃权走惩罚分支） */
  private reaskProxyPlay(p: PendingAsk, reason: string): ActionResult {
    this.emit({ type: 'game:error', playerId: p.playerId, reason });
    this.suspend(p.playerId, p.entry, p.hookName, p.args, p.resume, { ...p.ask, askId: undefined }, 'proxyPlay');
    return this.ok();
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
        !this.playBanned(p.id) &&
        p.id !== this.roundLastPlayerId &&
        // 温柔（组长）：宝贝不得响应组长的出牌（插队是出牌类响应）
        !(this.babies.has(p.id) && this.tableOwnerId === this.babyOwnerId) &&
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
      this.soloJokerAllowed(cutter.id),
      this.liu2ExemptFor(cutter.id)
    ).some((c) => c.cards.some((card) => !isJoker(card) && playedSuits.has(card.suit)));
    if (!qualifying) {
      this.advanceTurn();
      return this.ok();
    }
    this.suspend(cutter.id, null, null, [], () => {}, { kind: 'cutIn', prompt: '是否抢先接牌？' });
    return this.suspendedOk();
  }

  private commitCutIn(playerId: string, combo: Combo): ActionResult {
    const effOwner = this.exciteOwnerFor(playerId, combo); // 亢奋：插队打出同样适用
    const flips = this.orderFlippers.has(effOwner ?? playerId);
    if (flips) this.orderFlipCount++; // 插队也是物理出牌：洄游照常切换
    this.aftermathMode = 'cutIn';
    this.cutInVictimId = this.tableOwnerId;
    this.removeCards(playerId, combo.cards);
    const prevSuits: Set<number> = this.tableCombo
      ? new Set(this.tableCombo.cards.filter((c) => !isJoker(c)).map((c) => c.suit))
      : new Set();
    if (this.tableCombo) this.discardCards([...this.tableCombo.cards]);
    const prevCombo = this.tableCombo;
    this.tableCombo = combo;
    this.tableRankNote = null;
    if (flips) this.resyncTableOrder(); // 洄游：切换后桌面按新牌序重新解析（rank 约定反转）
    this.prevTableOwnerId = this.tableOwnerId === '' ? null : this.tableOwnerId;
    this.prevTableSuits = this.prevTableOwnerId == null ? new Set<number>() : prevSuits;
    this.prevTableCombo = this.prevTableOwnerId == null ? null : prevCombo;
    this.tableOwnerId = playerId;
    this.lastPlayPhysicalId = playerId; // 尖叫（苗条）：插队也是打出，实际打出者同样记录
    this.roundLastPlayerId = playerId;
    this.passCount = 0;
    this.provisionalLeadId = null; // 吐饼（R.F）：插队打出新牌
    this.pancakeNoPassId = null;
    this.lastPlayWasCutIn = true;
    this.emit({ type: 'cards:played', playerId, combo });
    if (effOwner) this.attributeTable(effOwner); // 亢奋：插队归属惰戈（受害者仍是旧桌面所有者，已在上面捕获）
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
    // 吐饼（R.F）：轮末钩子（隐匿等）结算后立即判定获胜（2026-10-06 用户定稿）
    if (this.checkPancakeWin()) return;
    // 空手获胜：手牌+扣置全空 → 立即判胜（同上口径，2026-10-06 用户定稿）
    if (this.checkEmptyHandWin()) return;
    this.finishRoundEnd(lastId);
  }

  private finishRoundEnd(lastId: string): void {
    const mods = this.pendingMods.get(lastId);
    // 约等（煞蔱）拥有牌权：收回刚打的一手牌并均分——她出 0 张不用摸牌，从她下家继续接牌
    if (mods?.yueDeng) {
      const targetId = mods.yueDeng.targetId;
      delete mods.yueDeng;
      if (Object.keys(mods).length === 0) this.pendingMods.delete(lastId);
      if (this.phase === 'playing') this.yueDengRevert(lastId, targetId);
      return;
    }
    let suppress = false;
    if (mods?.suppressDraw) {
      delete mods.suppressDraw;
      suppress = true;
    }

    if (mods && Object.keys(mods).length === 0) this.pendingMods.delete(lastId);
    // 地坛取而代之：被诅咒者本回合轮末获得牌权 → 诅咒者代替摸牌并起新回合
    const seizedBy = this.pendingBan.get(lastId)!;
    const takenOver = !!seizedBy && !this.eliminated.has(seizedBy);
    const drawId = takenOver ? seizedBy : lastId;
    if (!suppress && this.cfg.roundEnd.lastPlayerDraws && this.cfg.roundEnd.drawCount > 0) {
      // 神秘（辛歼）：摸牌阶段自选 1 或 2 张（超时默认 1）
      if (drawId === this.mysticPlayerId) {
        this.suspendEngine(
          drawId,
          {
            kind: 'choice',
            prompt: '【神秘】摸牌阶段：选择摸 1 张或 2 张',
            options: ['摸 1 张', '摸 2 张'],
            declineAllowed: false,
          },
          (answer) => {
            const n = answer.choice === '摸 2 张' ? 2 : 1;
            const drew = this.drawCards(drawId, n);
            if (this.phase !== 'playing') return;
            this.afterRoundEndDraw(lastId, takenOver, drew);
          }
        );
        return;
      }
      const drew = this.drawCards(drawId, this.cfg.roundEnd.drawCount);
      if (this.phase !== 'playing') return;
      this.afterRoundEndDraw(lastId, takenOver, drew);
      return;
    }
    if (this.phase !== 'playing') return;
    this.afterRoundEndDraw(lastId, takenOver, 0);
  }

  /** 轮末摸牌后的收尾：诅咒轮更 → 起新回合 */
  private afterRoundEndDraw(lastId: string, takenOver: boolean, drew: number): void {
    const seizedBy = this.pendingBan.get(lastId)!;
    const drawId = takenOver ? seizedBy : lastId;
    // 轮更：本轮判定成功的诅咒下一轮生效
    this.activeBan = new Set(this.pendingBan.keys());
    this.pendingBan.clear();
    let leader = drawId;
    if (this.eliminated.has(leader)) leader = this.nextSeat(leader);
    // 防御：被诅咒者不得到牌权就跳过（取而代之者被淘汰等边缘），起牌者绝不能是禁出玩家
    if (this.activeBan.has(leader) && !this.bpProtected(leader)) {
      const alt = this.players.find((p) => !this.eliminated.has(p.id) && !this.activeBan.has(p.id));
      if (alt) leader = alt.id;
    }
    this.emit({ type: 'round:ended', lastPlayerId: lastId, drew, ledBy: takenOver ? seizedBy : undefined });
    this.startRound(leader);
  }

  private finishGame(winnerId: string): void {
    if (this.phase === 'finished') return; // 守卫：耀武/淘汰可能在技能解析中先于获胜判定终局，避免重复计分
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
    // 神秘（辛歼）：override 的私有牌（id 162..215）从独立牌堆扣除（测试白盒塞私有牌时守恒 216）
    this.privateDeck = this.privateDeck.filter((c) => !used.has(c.id));
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
    const actual = this.rawDraw(playerId, n + bonus); // 两倍（玊）翻倍在 rawDraw 内统一处理
    if (actual > 0) this.emit({ type: 'cards:drawn', playerId, count: actual });
    return actual;
  }

  /** 原始摸牌（不走钩子、不吃 drawBonus）；两倍（玊）：一切从牌堆摸的牌 ×2（发牌/轮末/技能摸牌；
   *  拿回特定牌与别人给牌走 takeRevealed/giveRevealed，不翻倍——2026-10-04 用户确认） */
  private rawDraw(playerId: string, n: number): number {
    if (n <= 0) return 0;
    // 神秘（辛歼）：一切从牌堆摸的牌都从独立牌堆摸（摸空时独立弃牌堆洗回；两堆都空则摸不到）
    if (playerId === this.mysticPlayerId) return this.privateDraw(playerId, n);
    this.recycleDiscard(); // 牌堆耗尽洗回（2026-10-05 用户确认）：牌堆空时弃牌堆洗回当新牌堆
    const total = n * (this.doubleSupplyFor(playerId) ? 2 : 1);
    const actual = Math.min(total, this.deck.length);
    const drawn = this.deck.splice(this.deck.length - actual, actual);
    const hand = this.hands.get(playerId);
    if (hand) {
      hand.push(...drawn);
      this.checkHandLimit(playerId);
    }
    // 自定义摸牌（Elm）：刚摸到的牌记入待换牌记录（动作收尾逐张询问换牌）
    if (this.devDrawOn.has(playerId) && drawn.length > 0) this.recordDevDraw(playerId, 'deck', drawn);
    if (this.phase === 'playing') this.checkYaoWu(); // 耀武（阿摩）：摸牌后立即判定（发牌阶段的检查统一在 start 末尾做）
    return actual;
  }

  /** 神秘（辛歼）：从独立牌堆摸牌（独立弃牌堆洗回继续自己用；不翻倍、不参与公共洗回） */
  private privateDraw(playerId: string, n: number): number {
    if (this.privateDeck.length === 0 && this.privateDiscard.length > 0) {
      this.privateDeck = shuffle(this.privateDiscard, this.rng);
      this.privateDiscard = [];
      this.emit({ type: 'deck:recycled', count: this.privateDeck.length });
    }
    const actual = Math.min(n, this.privateDeck.length);
    const drawn = this.privateDeck.splice(this.privateDeck.length - actual, actual);
    const hand = this.hands.get(this.mysticPlayerId!);
    if (hand) {
      hand.push(...drawn);
      this.checkHandLimit(this.mysticPlayerId!);
    }
    // 自定义摸牌（Elm）：独立牌堆摸的牌同样可换
    if (this.devDrawOn.has(playerId) && drawn.length > 0) this.recordDevDraw(playerId, 'private', drawn);
    if (this.phase === 'playing') this.checkYaoWu(); // 耀武（阿摩）：摸牌后立即判定
    return actual;
  }

  /** 弃置路由：辛歼（神秘）的牌（按牌面 id）进独立弃牌堆，其余进公共弃牌堆 */
  private discardCards(cards: Card[]): void {
    for (const c of cards) {
      if (this.privateCardIds.has(c.id)) this.privateDiscard.push(c);
      else this.discarded.push(c);
    }
  }

  /**
   * 牌堆耗尽洗回（2026-10-05 用户确认，全局规则）：牌堆空时弃牌堆洗回当新牌堆继续摸；
   * 判定类技能「牌堆已空视为未判定」相应变为「牌堆+弃牌堆都空才视为未判定」（revealTop 同走此路）。
   * 牌守恒不变：162 = 手牌+桌面+牌堆+弃牌+饼+翻牌池+边牌+弃牌暂存区，洗回只是牌堆/弃牌两堆之间流转。
   */
  private recycleDiscard(): void {
    if (this.deck.length > 0 || this.discarded.length === 0) return;
    this.deck = shuffle(this.discarded, this.rng);
    this.discarded = [];
    this.emit({ type: 'deck:recycled', count: this.deck.length });
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
    if (mods.yueDeng) cur.yueDeng = mods.yueDeng; // 约等（煞蔱）：afterPlayCommitted 消费
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
    // 尖叫（苗条）：扣置牌一并进弃牌堆（牌守恒）
    const heldCards = (this.held.get(playerId) ?? []).flatMap((g) => g.cards);
    this.held.delete(playerId);
    if (hand.length > 0 || heldCards.length > 0) this.discardCards([...hand, ...heldCards]);
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
    // 尖叫（苗条）：扣置牌也算手牌（手牌 + 扣置 > 上限即淘汰；收回只是挪回手里，总数不变）
    const heldCount = (this.held.get(playerId) ?? []).reduce((s, g) => s + g.cards.length, 0);
    // 贪婪（阿摩）：上限 30；两倍（玊）：20×2=40；超出均照常淘汰
    const limit = this.roles.get(this.players.find((p) => p.id === playerId)?.roleId ?? '')?.greedy
      ? 30
      : this.cfg.hand.limit * (this.doubleSupplyFor(playerId) ? 2 : 1);
    if (hand.length + heldCount - exempt > limit) this.eliminate(playerId, '手牌超过上限');
  }

  private activeCount(): number {
    return this.players.filter((p) => !this.eliminated.has(p.id)).length;
  }

  // ---------- 耀武（阿摩）：手牌覆盖 A~K 全部 13 点立即获胜（2026-10-05 用户确认） ----------

  /** 手牌变化后立即判定（发牌/摸牌/收牌/别人给牌后调用）；满足即终局 */
  private checkYaoWu(): boolean {
    for (const p of this.players) {
      if (this.eliminated.has(p.id)) continue;
      if (!this.roles.get(p.roleId)?.yaoWu) continue;
      if (yaoWuCovers(this.hands.get(p.id) ?? [])) {
        this.emit({
          type: 'skill:triggered',
          playerId: p.id,
          roleId: p.roleId,
          skillId: 'yao-wu',
          text: `${p.name} 集齐 A~K 全部点数，直接宣布胜利！`,
        });
        this.finishGame(p.id);
        return true;
      }
    }
    return false;
  }

  // ---------- 吐饼（R.F）：饼数 ≥ 手牌数 → 无条件立即获胜（2026-10-06 用户定稿） ----------

  /**
   * 手牌变化后统一判定吐饼获胜：饼数 ≥ 手牌数即宣布获胜，不看来因（自己出牌/别人弃牌/换牌/拼点……
   * 一切致手牌减少的路径都触发）。出牌路径在 afterPlayCommitted 收尾处调用——打断钩子（含亡语）已
   * 全部结算完，亡语先于获胜判定（除非有亡语，否则直接获胜）。其余结算点：吃饼倒置（finishPancake）、
   * 主动技（finishSkillAction）、回合开始钩子（runTurnStartHooks）、轮末钩子（runRoundEndHooks）、过牌
   * （pass）。满足即终局。
   */
  private checkPancakeWin(): boolean {
    if (this.phase !== 'playing') return false;
    const p = this.pancakeWinCandidate();
    if (!p) return false;
    this.emit({
      type: 'skill:triggered',
      playerId: p.id,
      roleId: p.roleId,
      skillId: 'tu-bing',
      text: `【吐饼】${p.name} 饼数已达手牌数，直接宣布胜利！`,
    });
    this.finishGame(p.id);
    return true;
  }

  /** 吐饼获胜候选（无副作用）：饼数 ≥ 手牌数的未淘汰 pancake 角色。
   *  2026-10-06 用户定稿：条件一旦满足即宣判——亡语门控（runAfterPlayHooks/runInterruptHooks）
   *  也用它：出牌后已满足获胜条件的，非亡语技能不再触发，亡语钩子照常先结算。 */
  private pancakeWinCandidate(): EnginePlayer | null {
    for (const p of this.players) {
      if (this.eliminated.has(p.id)) continue;
      if (!this.roles.get(p.roleId)?.pancake) continue;
      if ((this.pancakes.get(p.id)?.length ?? 0) >= (this.hands.get(p.id)?.length ?? 0)) return p;
    }
    return null;
  }

  // ---------- 空手获胜（2026-10-06 用户定稿） ----------

  /** 空手获胜候选（无副作用）：手牌 + 扣置全空的未淘汰玩家。
   *  2026-10-06 用户定稿：不看来因（同吐饼口径）——自己打光/法音弃置/给别人牌，一切致手牌与
   *  扣置归零的路径都触发。挂在结算点判定（亡语先结算：尖叫打光自动收回扣置牌在打断钩子里已
   *  先执行，手牌非空则不满足）；扣置牌也算手牌（苗条 0 手但有扣置 → 不判胜，可主动收回）。 */
  /** 手牌 + 扣置牌总张数（扣置牌也算手牌——尖叫苗条；上限/空手判胜/出完即胜/亡语门控同口径） */
  private handHeldTotal(playerId: string): number {
    return (
      (this.hands.get(playerId)?.length ?? 0) +
      (this.held.get(playerId) ?? []).reduce((s, g) => s + g.cards.length, 0)
    );
  }

  private emptyHandWinCandidate(): EnginePlayer | null {
    for (const p of this.players) {
      if (this.eliminated.has(p.id)) continue;
      if (this.handHeldTotal(p.id) === 0) return p;
    }
    return null;
  }

  /** 空手获胜统一判定：全局扫描，命中即宣布获胜。结算点同 checkPancakeWin（afterPlayCommitted
   *  收尾 / finishPancake / finishSkillAction / runTurnStartHooks / runRoundEndHooks / pass）。 */
  private checkEmptyHandWin(): boolean {
    if (this.phase !== 'playing') return false;
    const p = this.emptyHandWinCandidate();
    if (!p) return false;
    this.finishGame(p.id);
    return true;
  }

  // ---------- 翻牌展示区 ----------

  /** 翻牌堆顶 n 张到展示区（角色须 takeRevealed/giveRevealed/discardRevealed 收尾） */
  private revealTop(n: number): Card[] {
    this.recycleDiscard(); // 洗回后翻牌；牌堆+弃牌堆都空 → 翻 0 张（判定类技能视为未判定）
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
      this.discardCards(taken);
      return;
    }
    hand.push(...taken);
    if (exempt) this.handLimitExempt.set(playerId, (this.handLimitExempt.get(playerId) ?? 0) + taken.length);
    this.checkHandLimit(playerId);
    if (this.phase === 'playing') this.checkYaoWu(); // 耀武（阿摩）：拿回/收下牌后立即判定
  }

  /** 展示区指定牌（缺省全部）→ 弃牌堆 */
  private discardRevealed(cardIds?: number[]): void {
    if (!cardIds) {
      this.discardCards([...this.revealedPool]);
      this.revealedPool = [];
      return;
    }
    const ids = new Set(cardIds);
    this.discardCards([...this.revealedPool.filter((c) => ids.has(c.id))]);
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
    // 记录当前钩子条目（障目 zhangMuCheck 续跑 applyOutcome 用；钩子内不会重入 runHook 之外）
    const prevEntry = this.runningEntry;
    this.runningEntry = entry;
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
    } finally {
      this.runningEntry = prevEntry;
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
        if (engine.phase === 'playing') engine.checkYaoWu(); // 耀武（阿摩）：别人给牌（骚骚换牌等）后立即判定
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
        // 见习（陈正）罚站：技能可用但不得打出（茄汤成炸等强制出牌在罚站中落空）；血压保护者豁免
        if (engine.playBanned(playerId)) return;
        // 温柔（组长）：宝贝不得响应组长的出牌——茄汤成炸等出牌类技能响应同样落空
        if (engine.tableCombo && engine.babies.has(playerId) && engine.tableOwnerId === engine.babyOwnerId) return;
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
      peekHand: (targetId) => engine.peekHand(playerId, targetId),
      banPlayThisRound: (targetId) => {
        // 见习（陈正）：目标本回合罚站（不得出牌、不被技能选为目标；自己的技能仍可用）
        if (!engine.eliminated.has(targetId)) engine.roundBanned.add(targetId);
      },
      isBannedThisRound: (id) => engine.roundBanned.has(id),
      discardCount: () => engine.discarded.length,
      playBanned: (id) => engine.playBanned(id),
      playGateBlocked: (id) => engine.playGateBlocked(id),
      bpProtected: (id) => engine.bpProtected(id),
      markBaby: (id) => {
        engine.babies.add(id);
        engine.babyOwnerId = playerId; // 温柔（组长）：宝贝禁响应的基准是标记者本人
      },
      isBaby: (id) => engine.babies.has(id),
      tableOwnerId: () => (engine.tableOwnerId === '' ? null : engine.tableOwnerId),
      lastPlayPhysicalId: () => engine.lastPlayPhysicalId,
      holdCards: (kind, cardIds) => engine.holdCards(playerId, kind, cardIds),
      takeHeldBack: (cardIds) => engine.takeHeldBack(playerId, cardIds),
      heldGroups: () => engine.held.get(playerId) ?? [],
      giveHeldTo: (toId, cardIds) => engine.giveHeldTo(playerId, toId, cardIds),
      zhangMuCheck: (casterId, targetId, skillId, cont) =>
        engine.zhangMuCheck(casterId, targetId, skillId, cont, opts?.answer),
      privateDeckCount: () => engine.privateDeck.length,
      privateDiscardCount: () => engine.privateDiscard.length,
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
    const combo = relabelCombo(this.tableCombo, rank as Rank, this.orderReversed());
    this.tableCombo = combo;
    this.tableRankNote = { rank };
    // 修勾×惰戈联动（2026-10-06 用户确认）：改判后的判定点数和 ≥20 → 这手牌归属惰戈（亢奋）。
    // 间隔语义：改判发生在打出之后——「打出那一刻」生效的技能（洄游切换等）已照常触发、不撤销；
    // 原出牌者仍算本回合出过牌。已归属（惰戈自己打出或打出时点数和已 ≥20）不重复改写。
    const retaggable =
      combo.type === 'pair' || combo.type === 'bomb' || combo.type === 'straight' || combo.type === 'consecutivePairs';
    if (retaggable && this.retaggedPointSum(combo) >= 20) {
      const owner = this.exciteOwnerExcept(this.tableOwnerId);
      if (owner) this.attributeTable(owner);
    }
  }

  /** 答疑改判后的判定点数和（口径同亢奋：2 记 2、A 记 1；对/炸 = 张数×点数；
   *  顺子/连对 = 按改判起点展开的窗口逐张求和，倒序起点 = 最高点） */
  private retaggedPointSum(combo: Combo): number {
    if (combo.type === 'pair') return 2 * pointValue(combo.rank);
    if (combo.type === 'bomb') return combo.length * pointValue(combo.rank);
    const span = combo.type === 'straight' ? combo.length : combo.length / 2;
    const start = this.orderReversed() ? combo.rank - span + 1 : combo.rank;
    let sum = 0;
    for (let i = 0; i < span; i++) sum += pointValue((start + i) as Rank);
    return combo.type === 'consecutivePairs' ? 2 * sum : sum;
  }

  /** 地坛（橐驼）：诅咒目标玩家下一轮不得出牌（自动过、不能起牌/插队/狂吠）；
   *  若其本回合轮末获得牌权，由诅咒者取而代之（摸牌 + 起新回合）。轮末生效、下轮结束清除。 */
  private curseNextRound(bannerId: string, targetId: string): void {
    if (targetId === bannerId) return;
    const target = this.players.find((p) => p.id === targetId);
    if (!target || this.eliminated.has(targetId)) return;
    this.pendingBan.set(targetId, bannerId);
  }

  /** 手牌指定牌 → 弃牌暂存区（2026-10-06 用户规则：本回合公开可见——谁弃了什么全场都看得到，轮末进弃牌堆） */
  private discardFromHand(playerId: string, cardIds: number[]): void {
    const hand = this.hands.get(playerId);
    if (!hand) return;
    const ids = new Set(cardIds);
    const taken = hand.filter((c) => ids.has(c.id));
    if (taken.length === 0) return;
    this.hands.set(playerId, hand.filter((c) => !ids.has(c.id)));
    this.stagedDiscards.push({ playerId, cards: taken });
  }

  /** 窃笑（轴承）：私密查看一名玩家的手牌——查看者与目标各收一条私有事件（服务端按人路由，不广播） */
  private peekHand(viewerId: string, targetId: string): void {
    const hand = this.hands.get(targetId);
    if (!hand) return;
    this.emit({ type: 'skill:peek', viewerId, targetId, cards: [...hand] });
    this.emit({ type: 'skill:peeked', viewerId, targetId });
  }

  // ---------- 尖叫（苗条）扣置区 ----------

  /** 扣置手牌为范文/尖叫鸡（引擎校验牌在手、扣后手牌 ≥1）；牌离开手牌进扣置区，牌背对其他人不可见 */
  private holdCards(playerId: string, kind: 'fanwen' | 'jianjiaoji', cardIds: number[]): void {
    const hand = this.hands.get(playerId);
    if (!hand || cardIds.length === 0) return;
    const cards: Card[] = [];
    for (const id of cardIds) {
      const c = hand.find((x) => x.id === id);
      if (!c) throw new Error('扣置牌不在手牌中');
      cards.push(c);
    }
    if (cards.length >= hand.length) throw new Error('扣置后手牌不能为空');
    for (const c of cards) hand.splice(hand.indexOf(c), 1);
    const groups = this.held.get(playerId) ?? [];
    groups.push({ kind, cards });
    this.held.set(playerId, groups);
    this.emit({ type: 'cards:held', playerId, kind, count: cards.length });
  }

  /** 收回扣置牌到手中（缺省全部；不消耗次数）。扣置牌也算手牌（上限 = 手牌 + 扣置），
   *  收回只是挪回手里，总数不变、不会导致超限淘汰（2026-10-06 用户确认） */
  private takeHeldBack(playerId: string, cardIds?: number[]): void {
    const groups = this.held.get(playerId) ?? [];
    if (groups.length === 0) return;
    const hand = this.hands.get(playerId);
    if (!hand) return;
    const ids = cardIds?.length ? new Set(cardIds) : null;
    let back = 0;
    const next: HeldGroup[] = [];
    for (const g of groups) {
      if (ids) {
        const keep = g.cards.filter((c) => !ids.has(c.id));
        const taken = g.cards.filter((c) => ids.has(c.id));
        hand.push(...taken);
        back += taken.length;
        if (keep.length > 0) next.push({ kind: g.kind, cards: keep });
      } else {
        hand.push(...g.cards);
        back += g.cards.length;
      }
    }
    this.held.set(playerId, next);
    if (back === 0) return;
    this.emit({ type: 'cards:heldBack', playerId, count: back });
  }

  /** 把指定扣置牌发给打出者（范文按花色逐张、尖叫鸡一次发完）；接收者照常受手牌上限约束 */
  private giveHeldTo(fromId: string, toId: string, cardIds: number[]): void {
    const groups = this.held.get(fromId) ?? [];
    const ids = new Set(cardIds);
    const given: Card[] = [];
    const next: HeldGroup[] = [];
    for (const g of groups) {
      const keep = g.cards.filter((c) => !ids.has(c.id));
      given.push(...g.cards.filter((c) => ids.has(c.id)));
      if (keep.length > 0) next.push({ kind: g.kind, cards: keep });
    }
    if (given.length === 0) return;
    this.held.set(fromId, next);
    const hand = this.hands.get(toId);
    if (!hand) return;
    hand.push(...given);
    this.checkHandLimit(toId);
    if (this.phase === 'playing') this.checkYaoWu(); // 耀武（阿摩）：收到牌后立即判定
    this.emit({ type: 'cards:heldGiven', playerId: fromId, toPlayerId: toId, count: given.length });
  }

  // ---------- 询问挂起 ----------

  private suspend(
    playerId: string,
    entry: HookEntry | null,
    hookName: keyof RoleHooks | null,
    args: unknown[],
    resume: (outcome: HookOutcome) => void,
    ask: SkillAsk,
    internalKind?: 'hook' | 'cutIn' | 'pancake' | 'proxyPlay' | 'engine'
  ): void {
    ask.askId = ask.askId ?? this.newAskId();
    ask.timeoutMs = ask.timeoutMs ?? this.cfg.timeout.skillAskMs;
    // 见习（陈正）罚站：被罚站的玩家不能被任何技能选为目标（2026-10-05 用户确认：不得被技能响应）
    // 血压（硝烟）：手牌 ≥8 的保护者同样不能被技能选为目标（2026-10-06 用户确认：全挡含增益）
    if (ask.targetCandidates) {
      ask.targetCandidates = ask.targetCandidates.filter((id) => !this.roundBanned.has(id) && !this.bpProtected(id));
    }
    // 被询问者缺省为技能所有者（playerId）；「依次自选」/讲题代打类技能经 ask.askPlayerId 指向其他人
    // 讲题（硝烟）proxyPlay 询问可从任意提问钩子（回合开始）挂起：按 ask.kind 自动识别调度标签，
    // 否则 resolveAsk 会走通用重跑路径、把代打答案误判为「未能打出」（2026-10-06 修复）
    this.pendingAsk = {
      ask,
      playerId: ask.askPlayerId ?? playerId,
      kind: internalKind ?? (ask.kind === 'proxyPlay' ? 'proxyPlay' : entry ? 'hook' : 'cutIn'),
      entry,
      hookName,
      args,
      resume,
    };
  }

  private newAskId(): string {
    return `ask-${++this.askSeq}`;
  }

  /** 引擎级询问挂起（神秘初始手牌/摸牌 1-2 等）：不走钩子重跑，答复直接交给 onResolve */
  private suspendEngine(playerId: string, ask: SkillAsk, onResolve: (answer: AskAnswer) => void): void {
    this.suspend(playerId, null, null, [], () => {}, ask, 'engine');
    this.pendingAsk!.onResolve = onResolve;
  }

  // ---------- 自定义摸牌（Elm 开发者账号，2026-10-07） ----------
  // 平衡「自选 vs 方便」的定稿方案（用户确认：默认随机 + 手动开关、逐张点选）：
  // 开关开启后，摸牌照常立即随机完成（引擎结算流零破坏），本动作收尾统一挂起「换牌询问」——
  // 逐张问「刚摸到的 X 换成什么」：点网格指定一张（旧牌回堆、指定牌取出，守恒不变）/ 保持这张 / 剩余全部保持。
  // 开关关闭 = 完全随机零打扰。判定摸回（takeRevealed/尖叫给回扣置牌）不走 rawDraw，天然豁免。

  /** 自定义摸牌开关（服务端在 Elm 切换时调用；关闭时若有换牌询问挂起则按全部保持结束） */
  setDevDraw(playerId: string, on: boolean): void {
    if (on) {
      this.devDrawOn.add(playerId);
      return;
    }
    this.devDrawOn.delete(playerId);
    this.devPending.delete(playerId);
    if (this.pendingAsk?.playerId === playerId && this.pendingAsk.ask.kind === 'devSwap') {
      this.pendingAsk = null; // 挂起清除：服务端随后 drainEvents + 广播快照
    }
  }

  /** 摸牌记录：追加进该玩家的待换牌队列 */
  private recordDevDraw(playerId: string, source: 'deck' | 'private', drawn: Card[]): void {
    const rec = this.devPending.get(playerId);
    if (rec) {
      for (const c of drawn) rec.cards.push({ card: c, source });
    } else {
      this.devPending.set(playerId, { cards: drawn.map((c) => ({ card: c, source })), swapIndex: 0 });
    }
  }

  /** 牌面文本（换牌播报用） */
  private cardFaceLabel(c: Card): string {
    return isJoker(c) ? (c.rank === JOKER_BIG ? '大王' : '小王') : SUITS[c.suit] + rankLabel(c.rank);
  }

  /** 挂起第一张换牌询问（无待换牌/已有询问挂起则返回 false）；onDone = 逐张全部答完的收尾
   *  （构造期 = finishStart；动作期 = 空——resolveAsk 末尾的 ok() 自会排空广播） */
  private startDevSwapAsk(onDone: () => void): boolean {
    if (this.pendingAsk) return false;
    for (const [pid, rec] of this.devPending) {
      if (!this.devDrawOn.has(pid) || this.eliminated.has(pid)) {
        this.devPending.delete(pid);
        continue;
      }
      this.suspendEngine(pid, this.devSwapAsk(pid, rec), (ans) => this.devSwapStep(pid, ans, onDone));
      return true;
    }
    return false;
  }

  /** 逐张换牌：换这张 → 问下一张；找不到指定牌 → 重问当前张；超时/保持 → 下一张 */
  private devSwapStep(pid: string, ans: AskAnswer, onDone: () => void): void {
    const rec = this.devPending.get(pid);
    if (!rec) {
      onDone();
      return;
    }
    // 剩余全部保持 / 开关已关 / 玩家已淘汰：整条换牌链结束
    if (ans.choice === 'restKeep' || !this.devDrawOn.has(pid) || this.eliminated.has(pid)) {
      this.devPending.delete(pid);
      onDone();
      return;
    }
    const cur = rec.cards[rec.swapIndex]!;
    if (ans.swapSpec) {
      const found = this.takeSpecifiedCard(cur.source, ans.swapSpec);
      if (!found) {
        // 源堆里没有这张牌了：重问当前张
        this.suspendEngine(pid, this.devSwapAsk(pid, rec, '牌堆里已经没有这张牌了，'), (a) =>
          this.devSwapStep(pid, a, onDone),
        );
        return;
      }
      this.applyDevSwap(pid, cur.card, cur.source, found);
      if (this.phase === 'finished') {
        // 换牌触发耀武等立即获胜：结束换牌链（终局）
        this.devPending.delete(pid);
        onDone();
        return;
      }
    }
    // 无 swapSpec = 保持这张（含超时自动作答）
    rec.swapIndex++;
    if (rec.swapIndex >= rec.cards.length) {
      this.devPending.delete(pid);
      onDone();
      return;
    }
    this.suspendEngine(pid, this.devSwapAsk(pid, rec), (a) => this.devSwapStep(pid, a, onDone));
  }

  /** 换牌询问载荷（hint = 找不到牌重问的提示前缀） */
  private devSwapAsk(
    pid: string,
    rec: { cards: { card: Card; source: 'deck' | 'private' }[]; swapIndex: number },
    hint?: string,
  ): SkillAsk {
    const label = this.cardFaceLabel(rec.cards[rec.swapIndex]!.card);
    const progress = `${rec.swapIndex + 1}/${rec.cards.length}`;
    const base = `【自定义摸牌】刚摸到 ${label}（第 ${progress} 张），换成什么？`;
    return {
      kind: 'devSwap',
      prompt: hint ? hint + base : base,
      cards: [rec.cards[rec.swapIndex]!.card],
      swapIndex: rec.swapIndex,
      swapTotal: rec.cards.length,
      declineAllowed: false,
      timeoutMs: 60_000, // 开发者思考/操作时间，超时保持这张
    };
  }

  /** 从源堆找一张指定牌取出（找不到返回 null；不触发洗回） */
  private takeSpecifiedCard(source: 'deck' | 'private', spec: DevCardSpec): Card | null {
    const pool = source === 'private' ? this.privateDeck : this.deck;
    const idx = pool.findIndex((c) =>
      'joker' in spec
        ? isJoker(c) && c.rank === spec.joker
        : !isJoker(c) && c.suit === spec.suit && c.rank === spec.rank,
    );
    if (idx < 0) return null;
    return pool.splice(idx, 1)[0]!;
  }

  /** 执行换牌：手牌里的旧牌替换为指定牌，旧牌洗回源堆随机位置（守恒不变：牌堆/手牌各一进一出） */
  private applyDevSwap(playerId: string, oldCard: Card, source: 'deck' | 'private', newCard: Card): void {
    const hand = this.hands.get(playerId);
    if (hand) {
      const hi = hand.findIndex((c) => c.id === oldCard.id);
      if (hi >= 0) hand.splice(hi, 1, newCard);
      else hand.push(newCard); // 极端兜底：旧牌已不在手（挂起期间无操作，不应发生），新牌照给
    }
    const pool = source === 'private' ? this.privateDeck : this.deck;
    const at = Math.floor(this.rng() * (pool.length + 1));
    pool.splice(at, 0, oldCard);
    this.emit({
      type: 'skill:triggered',
      playerId,
      roleId: 'dev',
      skillId: 'dev-draw',
      text: `【自定义摸牌】${this.cardFaceLabel(oldCard)} → ${this.cardFaceLabel(newCard)}`,
    });
    if (this.phase === 'playing') this.checkYaoWu(); // 耀武（阿摩）：换牌后立即判定（可能集齐 13 点数获胜）
  }

  /**
   * 障目（辛歼）门控（2026-10-06 用户定稿）：非锁定指向性技能锁定辛歼时（目标确定后、生效前），
   * 施放者猜他的手牌数：猜错 → 技能失效、不扣次数、本回合不能再对其他人发动（对辛歼重试可再猜）；
   * 猜中 → 技能照常 + 辛歼自选摸 1-3 张（超时默认 1）。血压守卫：施放者受高血压保护不触发。
   * 门控以询问挂起展开（猜牌 → 摸牌 → 续跑效果）：每次钩子重跑先路由到这里（角色用 st.gate 标记再入）。
   * 返回 null = 无需门控/已通过（调用方照常执行效果）；返回 HookResult = 挂起（{ok:true}）或封锁（{ok:false}）。
   */
  /** 障目门控续跑（引擎内部路径，如无名加牌）：挂起猜牌 → （猜中）挂起摸牌 → 执行 finish；猜错/拦截则跳过 */
  private zhangMuGateRun(
    casterId: string,
    targetId: string,
    skillId: string,
    finish: () => ActionResult,
    messageTarget: string,
    answer?: AskAnswer
  ): void {
    let ran = false;
    const run = (): void => {
      if (ran) return;
      ran = true;
      this.requeue(finish()); // 续跑结果的事件重排回待广播队列（内层 ok() 已排空，防止事件被吞）
    };
    const gate = this.zhangMuCheck(
      casterId,
      targetId,
      skillId,
      () => {
        run();
        return { ok: true };
      },
      answer
    );
    if (!gate) {
      run(); // 无需门控（无辛歼/已通过/非指向辛歼）
      return;
    }
    if (!gate.ok) {
      this.emit({ type: 'game:error', playerId: messageTarget, reason: gate.reason });
      return;
    }
    if (!gate.ask) return; // 猜错跳过效果 / draw 阶段续跑已完成（run 已执行）
    if (ran) return; // 续跑内部已挂起新询问（狂吠等）：交给该询问自身处理
    this.suspendEngine(gate.ask.askPlayerId ?? casterId, gate.ask, (ans) => {
      this.zhangMuGateRun(casterId, targetId, skillId, finish, messageTarget, ans);
    });
  }

  private zhangMuCheck(
    casterId: string,
    targetId: string | null,
    skillId: string,
    cont: () => HookResult | void,
    answer?: AskAnswer
  ): HookResult | null {
    const mystic = this.mysticPlayerId;
    if (!mystic || casterId === mystic) return null;
    if (this.bpProtected(casterId)) return null; // 血压（硝烟）：受保护者的技能不被障目拦截
    const key = `${casterId}:${skillId}`;
    const stage = this.zhangMuPending.get(key);
    const mysticName = this.players.find((p) => p.id === mystic)?.name ?? '辛歼';
    if (stage === 'guess') {
      const actual = this.hands.get(mystic)?.length ?? 0;
      if (answer?.guess !== actual) {
        // 猜错（含超时）：技能失效、不消耗次数、本回合不能再对其他人发动
        this.zhangMuPending.delete(key);
        this.zhangMuBlocked.add(key);
        this.emit({
          type: 'skill:triggered',
          playerId: mystic,
          roleId: 'xin-jian',
          skillId: 'zhang-mu',
          text: `【障目】猜错了：此次技能失效，本回合不能再对其他人发动`,
        });
        return { ok: true }; // 效果跳过
      }
      // 猜中：技能照常，辛歼自选摸 1-3 张
      this.zhangMuPending.set(key, 'draw');
      this.emit({
        type: 'skill:triggered',
        playerId: mystic,
        roleId: 'xin-jian',
        skillId: 'zhang-mu',
        text: `【障目】猜中了：技能照常生效`,
      });
      return {
        ok: true,
        ask: {
          kind: 'choice',
          prompt: '【障目】你被猜中了：选择摸几张牌',
          options: ['摸 1 张', '摸 2 张', '摸 3 张'],
          askPlayerId: mystic,
          declineAllowed: false,
        },
      };
    }
    if (stage === 'draw') {
      // 摸牌答案（超时默认 1 张）：技能效果先跑完、摸牌挂账到本次动作收尾统一兑现（2026-10-07 用户反馈：
      // 摸 1-3 是为了让手牌数重新未知——窃笑偷看等效果必须先看到旧手牌，约等均分也不能把新摸的牌算进去）
      const n = Math.min(3, Math.max(1, ['摸 1 张', '摸 2 张', '摸 3 张'].indexOf(answer?.choice ?? '') + 1 || 1));
      this.zhangMuPending.delete(key);
      this.zhangMuPassed.add(key);
      if (this.phase === 'playing') {
        this.zhangMuDrawQueue.push(n);
        const r = cont();
        // 续跑结果带询问（如直播摸牌后进入「选择一项」）：转交挂起；带 modify：立即落盘
        if (r && r.ok && r.ask) return { ok: true, ask: r.ask };
        if (r && r.ok && this.runningEntry) this.applyOutcome(this.runningEntry, { vetoed: false, result: r });
      }
      return { ok: true };
    }
    if (this.zhangMuPassed.has(key)) return null; // 本回合已猜中通过：照常执行
    if (this.zhangMuBlocked.has(key) && targetId !== mystic) {
      this.emit({
        type: 'skill:triggered',
        playerId: mystic,
        roleId: 'xin-jian',
        skillId: 'zhang-mu',
        text: '【障目】猜错后本回合不能再对其他人发动该技能',
      });
      return { ok: true }; // 技能跳过、不出牌否决（2026-10-06 修复：{ok:false} 会连带否决触发技能的那次出牌）
    }
    if (targetId === mystic) {
      this.zhangMuPending.set(key, 'guess');
      return {
        ok: true,
        ask: {
          kind: 'guess',
          prompt: `【障目】猜测 ${mysticName} 的手牌数（1-20，超时算猜错）`,
          min: 1,
          max: 20,
          askPlayerId: casterId,
          declineAllowed: false,
        },
      };
    }
    return null;
  }

  /** 障目延迟摸牌兑现：本次动作的技能效果全部跑完（无挂起询问）后统一摸牌（2026-10-07 用户反馈）。
   *  猜中即摸（技能后续被放弃也摸）；辛歼被淘汰或游戏结束则作废。 */
  private flushZhangMuDraws(): void {
    if (this.phase !== 'playing' || this.pendingAsk || this.zhangMuDrawQueue.length === 0) return;
    const mystic = this.mysticPlayerId;
    if (!mystic || this.eliminated.has(mystic)) {
      this.zhangMuDrawQueue.length = 0;
      return;
    }
    const mysticName = this.players.find((p) => p.id === mystic)?.name ?? '辛歼';
    for (const n of this.zhangMuDrawQueue.splice(0)) {
      const drawn = this.rawDraw(mystic, n);
      if (drawn > 0) {
        this.emit({
          type: 'skill:triggered',
          playerId: mystic,
          roleId: 'xin-jian',
          skillId: 'zhang-mu',
          text: `${mysticName} 摸 ${drawn} 张牌`,
        });
      }
    }
  }

  private finishSkillAction(playerId: string): void {
    // 吐饼（R.F）：主动技（换牌/拼点等）结算后立即判定获胜（2026-10-06 用户定稿）
    if (this.checkPancakeWin()) return;
    // 空手获胜：手牌+扣置全空 → 立即判胜（同上口径，2026-10-06 用户定稿）
    if (this.checkEmptyHandWin()) return;
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

  /**
   * 亢奋（惰戈）：点数和 ≥20 的手牌打出那一刻归属改写的惰戈（无则 null）。
   * 点数和 = 牌面点数（2 记 2、A 记 1、J=11、Q=12、K=13，2026-10-04 用户确认），
   * 王按所当点数（combo.resolved）、单王/对王视为无穷（必触发）；惰戈被淘汰后失效；
   * 惰戈自己打出的牌不重复改写。提交路径在翻转/判定钩子之前调用，保证「打出那一刻即算惰戈出的」。
   */
  private exciteOwnerFor(playerId: string, combo: Combo): string | null {
    // 血压（硝烟）：亢奋归属改写是技能对其生效（改变其出牌的归属/判定基准）→ 手牌 ≥8 时不归属
    if (this.bpProtected(playerId)) return null;
    const infinite = combo.type === 'singleJoker' || combo.type === 'jokerPair';
    let sum = 0;
    if (!infinite) {
      for (const c of combo.cards) {
        const r = combo.resolved.find((x) => x.cardId === c.id)?.rank ?? c.rank;
        sum += pointValue(r);
      }
    }
    if (!infinite && sum < 20) return null;
    return this.exciteOwnerExcept(playerId);
  }

  /** 亢奋归属候选：惰戈中第一个未淘汰且不是 excludeId 的玩家（无则 null）。
   *  答疑改判归属（retagTable）复用同一候选逻辑。 */
  private exciteOwnerExcept(excludeId: string): string | null {
    for (const id of this.exciteOwners) {
      if (id !== excludeId && !this.eliminated.has(id)) return id;
    }
    return null;
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
      listPlayable(
        this.hands.get(playerId)!,
        null,
        this.cfg,
        this.orderReversed(),
        this.soloJokerAllowed(playerId),
        this.liu2ExemptFor(playerId)
      )
    );
  }

  // ---------- 血压（硝烟）与温柔（组长）守卫 ----------

  /** 血压（硝烟，2026-10-06 用户确认）：手牌 ≥8 的未淘汰硝烟——其余人的技能一律不能对其生效（含增益）。
   *  禁打（诅咒/罚站）对其无效（动态：摸到 ≥8 立即解除）。 */
  private bpProtected(playerId: string): boolean {
    const p = this.players.find((x) => x.id === playerId);
    if (!p || this.eliminated.has(playerId)) return false;
    if (!this.roles.get(p.roleId)?.bloodPressure) return false;
    return (this.hands.get(playerId)?.length ?? 0) >= 8;
  }

  /** 该玩家当前是否被禁打（诅咒/罚站；血压保护者豁免） */
  private playBanned(playerId: string): boolean {
    if (this.bpProtected(playerId)) return false;
    return this.activeBan.has(playerId) || this.roundBanned.has(playerId);
  }

  /**
   * 出牌门控：该玩家此刻能否正常出牌（领出或响应桌面牌）。null = 可正常出牌。
   * 禁打（罚站/诅咒，血压豁免）→ 抽你响应限制 → 宝贝守卫（温柔）。
   * playCards 入口与讲题（硝烟）发动门控共用（2026-10-06 用户确认：讲题本质是硝烟出牌，
   * 硝烟本人被技能影响不允许出牌则讲题不能发动）。
   */
  private playGateBlocked(playerId: string): string | null {
    if (this.playBanned(playerId)) return this.banReason(playerId);
    if (this.tableCombo && this.tableResponderRestrict && playerId !== this.tableResponderRestrict) {
      const d = this.players.find((p) => p.id === this.tableResponderRestrict);
      return `【抽你】本回合只能由 ${d?.name ?? '指定玩家'} 响应`;
    }
    if (this.tableCombo && this.babies.has(playerId) && this.tableOwnerId === this.babyOwnerId) {
      return '【温柔】宝贝本回合不得响应组长的出牌';
    }
    return null;
  }

  /** 禁打拒绝原因文案（按生效的禁打类型） */
  private banReason(playerId: string): string {
    return this.roundBanned.has(playerId)
      ? '【见习】本回合罚站，不得出牌'
      : '【红楼梦】本回合不得出牌';
  }

  /** 可合法响应的组合：基础可管且未被 beforePlay 干跑否决（技能否决后允许过） */
  private legalResponses(playerId: string): Combo[] {
    // 见习（陈正）罚站：不得出牌 → 视为无牌可管（允许过）
    if (this.playBanned(playerId)) return [];
    // 温柔（组长）：宝贝对组长的桌面视为无牌可管（允许过）
    if (this.babies.has(playerId) && this.tableOwnerId === this.babyOwnerId) return [];
    // 响应限制（抽你）：非指定玩家视为无牌可管（允许过）
    if (this.tableResponderRestrict && playerId !== this.tableResponderRestrict) return [];
    let combos = listPlayable(
      this.hands.get(playerId)!,
      this.tableCombo,
      this.cfg,
      this.orderReversed(),
      this.soloJokerAllowed(playerId),
      this.liu2ExemptFor(playerId)
    );
    // 吐饼（R.F）无牌权限制：响应他人时只有 2/炸弹可直接打出（有牌能管必须出牌判断同口径）
    const role = this.roles.get(this.players.find((p) => p.id === playerId)!.roleId);
    if (role?.pancake && this.tableCombo && this.tableOwnerId !== playerId) {
      const rev = this.orderReversed();
      const rk = rev ? RANK_3 : RANK_2;
      combos = combos.filter(
        (c) => c.type === 'bomb' || ((c.type === 'single' || c.type === 'pair') && c.rank === rk)
      );
    }
    return this.playableNotVetoed(playerId, combos);
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
    // 障目延迟摸牌：动作链收尾时兑现（技能先生效、再摸 1-3；若期间又挂起新询问则留到该询问结算完）
    this.flushZhangMuDraws();
    // 自定义摸牌（Elm）：动作收尾挂起换牌询问（挂起时事件照常排空广播，逐张答完自动收尾）
    this.startDevSwapAsk(() => {});
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
    if (t.type === 'gap') return '只有炸弹能压（翻面接出的牌型）';
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
