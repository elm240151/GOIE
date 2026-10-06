import type { Card } from '../cards';
import type { RuleConfig } from '../config';
import type { Combo } from '../engine/combos';
import type { GameEvent } from '../engine/events';
import type { Rng } from '../engine/rng';

/** 角色允许的改牌操作（有界词汇表，引擎保证不变量不被破坏） */
export interface ActionMods {
  /** 该玩家下一次摸牌额外 +N */
  drawBonus?: number;
  /** 跳过接下来 N 名玩家（回合顺序） */
  skipNextPlayers?: number;
  /** 指定玩家下一回合强制过 */
  forcePass?: string[];
  /** 终局记分修正（加在输赢分上） */
  scoreDelta?: number;
  /** 仅 onDeal 可用：额外发牌 */
  extraDealCards?: number;
  /** 跳过本轮结束的自动摸牌（角色自行摸牌，如黑脸/观股） */
  suppressDraw?: boolean;
  /** 技能动作结束后视为过牌并轮到下家（换牌类技能取代出牌，如骚骚；其余人全过则本轮结束） */
  endTurn?: boolean;
  /** 淘汰指定玩家（手牌进弃牌堆、记 −1，仅剩一人时其直接获胜） */
  eliminate?: string[];
  /** 桌面作废，由技能所有者重新起牌（如巨石驱逐成功） */
  seizeLead?: boolean;
  /** 约等（煞蔱）：收回她刚打的一手牌，与目标均分手牌——桌面回退上一手、从她下家继续接牌（每回合限一次） */
  yueDeng?: { targetId: string };
}

export type HookResult =
  | { ok: true; modify?: ActionMods; allowAnyway?: boolean; ask?: SkillAsk }
  | { ok: false; reason: string };

// ---------- 技能询问（可选技能的服务端↔客户端问答） ----------

export type AskKind =
  | 'confirm'
  | 'suit'
  | 'choice'
  | 'pickCards'
  | 'pickTarget'
  | 'cutIn'
  | 'selfFollow'
  | 'proxyPlay'
  | 'guess';

export interface SkillAsk {
  /** 引擎自动生成（角色可不填） */
  askId?: string;
  kind: AskKind;
  prompt: string;
  /** suit / choice 的候选项 / confirm 无 */
  options?: string[];
  /** pickCards 的可选牌（自己/目标手牌或展示牌） */
  cards?: Card[];
  /** pickCards 盲抽：客户端只显示牌背（如骚骚摸对面牌）。服务端经 currentAsk 下发时会把牌面掩码 */
  hidden?: boolean;
  min?: number;
  max?: number;
  /** pickTarget 的可选目标 */
  targetCandidates?: string[];
  /** 被询问的玩家 id（缺省 = 技能所有者）；「依次自选」类技能用来依次问其他人 */
  askPlayerId?: string;
  /** 超时自动拒绝（服务端计时） */
  timeoutMs?: number;
  /** 是否允许弃权（缺省 true）；false = 被问者必须作答——弃权/超时由引擎按默认处理
   *  （choice/suit 取第一项、pickCards 取最前的牌），用于「对别人产生的效果不能弃权」类询问
   *  （讲题惩罚、法音弃牌、处分等，2026-10-06 用户确认）；客户端据此隐藏「放弃」按钮 */
  declineAllowed?: boolean;
}

/** 客户端对询问的回答（game:useSkill 载荷） */
export interface AskAnswer {
  askId: string;
  /** confirm: 'yes'|'decline'；suit: 花色符号；choice: 选项文本；cutIn/selfFollow: 'yes'|'decline'（带 cardIds 为出牌） */
  choice?: string;
  cardIds?: number[];
  targetPlayerId?: string;
  /** guess（障目猜手牌数，1-20） */
  guess?: number;
}

/** 主动技动作请求（game:useSkill → onSkillAction） */
export interface SkillActionRequest {
  skillId: string;
  cardIds?: number[];
  targetPlayerId?: string;
  choice?: string;
}

/** 角色的客户端技能按钮描述（通用渲染，不硬编码角色） */
export interface SkillActionDef {
  skillId: string;
  /** myTurn = 轮到自己时；following = 轮到自己且桌面有牌（接牌时） */
  when: 'myTurn' | 'following';
  /** 仅拥有牌权（本回合起牌者）时可用/显示（见习/反力矩：陈正起牌的回合才能发动） */
  onlyWhenLeader?: boolean;
  /** 不受「轮到出牌」限制、随时可用（尖叫收回扣置牌；有挂起询问时仍不可用） */
  anyTime?: boolean;
  /** 不在主动技按钮行渲染（苗条查看/收回扣置牌改由手牌上方扣置区弹窗承担；引擎动作入口仍保留） */
  hidden?: boolean;
  label: string;
}

export interface PlayerView {
  id: string;
  name: string;
  roleId: string;
  handCount: number;
  hand: readonly Card[];
}

/** 引擎对角色暴露的只读视图 + 受控操作 */
export interface EngineFacade {
  cfg: RuleConfig;
  players(): PlayerView[];
  handOf(id: string): readonly Card[];
  deckCount(): number;
  table(): Combo | null;
  /** 本手出牌前的桌面牌型（上一手被压的牌；起牌时 = null）。楠王【回味】计算点数差用 */
  prevTable(): Combo | null;
  /** 本手出牌前的桌面牌型所有者（上一手被压的人；起牌时 = null）。楠王【旺旺】判断压牌者用 */
  prevTableOwnerId(): string | null;
  turnPlayerId(): string;
  roundLeaderId(): string;
  phase(): 'dealing' | 'playing' | 'finished';
  passCount(): number;
  roundLastPlayerId(): string | null;
  /** 下家座位（skip 用于向后数，自动跳过被淘汰者） */
  nextSeatOf(id: string, skip?: number): string;
  /** 原始摸牌（不走钩子、不吃 drawBonus） */
  draw(playerId: string, n: number): void;
  /** 从某人手中移除指定牌（偷牌类技能前半段） */
  giveFrom(playerId: string, cardIds: number[]): void;
  /** 给某人塞牌（必须配合 giveFrom 使用，角色作者自己保证来源合法） */
  giveTo(playerId: string, cards: Card[]): void;
  /** 广播技能播报 */
  announce(roleId: string, skillId: string, text: string): void;
  /** 翻牌堆顶 n 张到展示区（不直接进手牌，需 takeRevealed/discardRevealed 收尾）；purpose 会随 cards:revealed 事件广播给所有人 */
  revealTop(n: number, purpose?: string): Card[];
  /** 展示区指定牌 → 某玩家手牌（判定牌，本回合不计入手牌上限） */
  takeRevealed(playerId: string, cardIds: number[]): void;
  /** 展示区指定牌 → 某玩家手牌（普通拿取，正常计入手牌上限） */
  giveRevealed(playerId: string, cardIds: number[]): void;
  /** 展示区指定牌（缺省全部）→ 弃牌堆 */
  discardRevealed(cardIds?: number[]): void;
  /** 公开亮出某些牌（如茄汤展示全部手牌） */
  revealCards(cards: Card[], purpose: string): void;
  /** 打出特殊组合（引擎校验后按正常出牌流程提交，如茄汤黑牌炸弹） */
  playForcedCombo(combo: Combo): void;
  eliminated(id: string): boolean;
  activeCount(): number;
  /** 当前桌面是否插队打出（无名） */
  lastPlayWasCutIn(): boolean;
  /** 刚打出的这一手响应了谁（起牌为 null；无名普通响应加牌判断用） */
  respondedTo(): string | null;
  /** 被压的那手牌的花色集合（无名：响应牌与被压牌同花色即触发） */
  respondedToSuits(): number[];
  /** 桌面一手牌归属改写（阿色再问/惰戈亢奋）：视作由 ownerId 打出，轮转从其下家继续、判定对其生效 */
  attributeTable(ownerId: string): void;
  /** 响应限制（阿色抽你）：当前桌面一手牌只能由 designatedId 响应；null 解除 */
  setTableResponderRestrict(designatedId: string | null): void;
  /** 明置一张手牌到桌旁（阿色再问补打：随当前一手牌一起弃置） */
  playSideCard(playerId: string, cardId: number): void;
  /** 当前是否倒序（海棠洄游切换后；角色压牌判定需据此镜像） */
  orderReversed(): boolean;
  /** 刚打出的这一手在哪个牌序下判定（洄游先判后切：本手按切换前顺序判定，巨石触发等按此镜像） */
  lastPlayOrderReversed(): boolean;
  /** 本轮内切换牌序角色（海棠）的实际出牌次数（隐匿：0 = 本回合尚未出牌） */
  flipCountThisRound(): number;
  /** 手牌指定牌 → 弃牌堆（隐匿重铸等） */
  discardFromHand(playerId: string, cardIds: number[]): void;
  /** 桌面一手牌的判定点数改为指定值（修勾答疑：牌型不变，顺子/连对 = 起点，按当前牌序约定） */
  retagTable(rank: number): void;
  /** 地坛（橐驼）：诅咒目标玩家下一轮不得出牌；若其本回合轮末获得牌权，由技能所有者取而代之 */
  curseNextRound(targetPlayerId: string): void;
  /** 窃笑（轴承）：私密查看目标玩家手牌（skill:peek 私发查看者、skill:peeked 私发目标） */
  peekHand(targetPlayerId: string): void;
  /** 见习（陈正）：目标玩家本回合罚站——不得出牌、不能被技能选为目标；自己的技能仍可用 */
  banPlayThisRound(targetPlayerId: string): void;
  /** 见习（陈正）：该玩家是否本回合罚站 */
  isBannedThisRound(playerId: string): boolean;
  /** 弃牌堆张数（压腿：牌堆+弃牌堆都空则无牌可翻，不询问） */
  discardCount(): number;
  /** 该玩家当前是否被禁打（诅咒/罚站；血压保护者豁免）——讲题（硝烟）自查能否发动 */
  playBanned(playerId: string): boolean;
  /** 出牌门控：该玩家此刻能否正常出牌（领出或响应桌面牌），null = 可出。
   *  禁打（血压豁免）→ 抽你响应限制 → 宝贝守卫（温柔）。
   *  讲题（硝烟）发动门控与代打（resolveProxyPlay 归属门控）共用：讲题本质是硝烟出牌（2026-10-06 用户确认） */
  playGateBlocked(playerId: string): string | null;
  /** 当前桌面一手牌的实际打出者（归属改写前）——尖叫（苗条）发牌给实际打出者：打光手牌的人摸回后才能避免获胜 */
  lastPlayPhysicalId(): string | null;
  /** 血压（硝烟）：该玩家是否受高血压保护（手牌 ≥8 的未淘汰硝烟）——其余人的技能不能对其生效 */
  bpProtected(playerId: string): boolean;
  /** 温柔（组长）：标记玩家为「宝贝」（本回合不得响应组长的出牌；轮末自动清空） */
  markBaby(playerId: string): void;
  /** 温柔（组长）：该玩家是否为宝贝 */
  isBaby(playerId: string): boolean;
  /** 温柔（组长）：当前桌面这手牌是否组长打出的（宝贝禁响应的判定基准） */
  tableOwnerId(): string | null;
  /** 尖叫（苗条）：扣置手牌为范文/尖叫鸡（引擎校验牌在手、扣后手牌 ≥1） */
  holdCards(kind: 'fanwen' | 'jianjiaoji', cardIds: number[]): void;
  /** 尖叫（苗条）：收回扣置牌到手中（缺省全部；不消耗次数） */
  takeHeldBack(cardIds?: number[]): void;
  /** 尖叫（苗条）：查看自己的扣置牌 */
  heldGroups(): HeldGroup[];
  /** 尖叫（苗条）：把指定扣置牌发给玩家（范文/尖叫鸡触发：打出者摸回） */
  giveHeldTo(playerId: string, cardIds: number[]): void;
  /** 障目（辛歼）门控：非锁定指向性技能锁定辛歼时，由技能在目标确定后、生效前调用。
   *  cont = 猜中并摸牌后经引擎续跑的技能效果（闭包捕获目标与答案）。返回 null = 无需门控（照常执行）；
   *  返回 HookResult = 挂起猜牌/摸牌询问（{ok:true}）或本回合封锁（{ok:false}）——调用方直接返回该结果。 */
  zhangMuCheck(
    casterId: string,
    targetId: string | null,
    skillId: string,
    cont: () => HookResult | void
  ): HookResult | null;
  /** 辛歼（神秘）：独立牌堆剩余张数 */
  privateDeckCount(): number;
  /** 辛歼（神秘）：独立弃牌堆张数 */
  privateDiscardCount(): number;
}

/** 尖叫（苗条）扣置组：范文 = 至多 4 张花色互不同；尖叫鸡 = 至多 3 张同花色 */
export interface HeldGroup {
  kind: 'fanwen' | 'jianjiaoji';
  cards: Card[];
}

export interface HookContext<S = unknown> {
  game: EngineFacade;
  self: PlayerView;
  /** 角色私有状态（setup 返回值，JSON 安全，随快照同步） */
  state: S;
  rng: Rng;
  /** 询问答案（仅 resolveAsk 重跑提问钩子时存在） */
  answer?: AskAnswer;
  /** 干跑（起牌死锁守卫模拟）：announce 不发声、modify 不生效 */
  dryRun?: boolean;
}

export interface RoleSetupContext {
  game: EngineFacade;
  self: PlayerView;
  rng: Rng;
}

export interface RoleHooks {
  /** 发牌时（可 extraDealCards） */
  onDeal?(ctx: HookContext): HookResult | void;
  /** 轮到出牌 */
  onTurnStart?(ctx: HookContext): HookResult | void;
  /** 出牌校验：在引擎基础规则校验之后运行；allowAnyway 放行、ok:false 否决（技能优先） */
  beforePlay?(ctx: HookContext, proposed: { combo: Combo; table: Combo | null }): HookResult | void;
  /** 出牌后 */
  afterPlay?(ctx: HookContext, played: Combo): HookResult | void;
  /** 出牌提交后、获胜判定前（驱逐类技能优先于获胜，如巨石）。可返回 ask 挂起 */
  onPlayInterrupt?(ctx: HookContext, played: Combo): HookResult | void;
  /** 过牌 */
  onPass?(ctx: HookContext): HookResult | void;
  /** 摸牌（n 为本次摸牌数） */
  onDraw?(ctx: HookContext, n: number): HookResult | void;
  /** 一轮结束（lastPlayerId 为最后出牌者）。可返回 ask 挂起（黑脸/观股） */
  onRoundEnd?(ctx: HookContext, lastPlayerId: string): HookResult | void;
  /** 游戏结束/记分 */
  onGameEnd?(ctx: HookContext, winnerId: string): HookResult | void;
  /** 主动技动作（game:useSkill 触发，如茄汤/骚骚）。可返回 ask 做多阶段交互 */
  onSkillAction?(ctx: HookContext, req: SkillActionRequest): HookResult | void;
}

export const HOOK_NAMES = [
  'onDeal',
  'onTurnStart',
  'beforePlay',
  'afterPlay',
  'onPlayInterrupt',
  'onPass',
  'onDraw',
  'onRoundEnd',
  'onGameEnd',
  'onSkillAction',
] as const;

/** 单个技能（一名角色可有 1-4 个；陈正为四技能角色） */
export interface SkillDef {
  /** kebab-case 唯一 id（announce/skill:triggered 用） */
  id: string;
  name: string;
  description: string;
  /** 锁定技（前端徽标显示） */
  locked?: boolean;
}

export interface RoleDef {
  /** kebab-case 唯一 id */
  id: string;
  /** 席位顺序（选角列表展示排序：1 = 首席…8 = 末席）；缺省排在已编号角色之后 */
  seatOrder?: number;
  name: string;
  /** 技能列表（1-2 个） */
  skills: SkillDef[];
  /** 同一房间最多几人选（默认 1） */
  maxPerRoom?: number;
  /** 钩子执行优先级（大者先执行，同优先级按座位序） */
  priority?: number;
  hooks?: Partial<RoleHooks>;
  /**
   * 亡语钩子（2026-10-05 用户定稿）：出牌者打完最后一张牌后（出完即胜判定前）仍可触发的钩子。
   * 只有标注在这里的钩子能在那时运行（有机会加牌/淘汰阻止获胜）；未标注的技能
   * 在打完牌的那一刻游戏就结束了——非亡语技能不在打完牌后触发。
   */
  deathrattleHooks?: (keyof RoleHooks)[];
  setup?(ctx: RoleSetupContext): unknown;
  /** 客户端技能按钮（通用渲染） */
  skillActions?: SkillActionDef[];
  /** 可插队响应（无名）——引擎提供插队机制，角色只挂标志 */
  canCutIn?: boolean;
  /** 出牌后可立刻压自己打出的牌，可连压到放弃/压不了（修勾狂吠）——引擎提供机制，角色只挂标志 */
  canSelfFollow?: boolean;
  /** 每次出牌（含插队，按物理出牌者）切换一次牌序正↔倒（海棠洄游）；每轮开始恢复正序 */
  flipsOrderOnPlay?: boolean;
  /** 单王可单独打出（橐驼诅咒）：点数视作无穷（正序压一切单张含 2、倒序同样压一切单张含 3），只有炸弹能压 */
  soloJoker?: boolean;
  /** 响应时可翻面一张上次打出的牌并接牌（轴承端庄）——引擎提供机制，角色只挂标志（客户端出翻面按钮） */
  canFlipResponse?: boolean;
  /**
   * 亢奋（惰戈）：点数和 ≥20 的手牌在打出那一刻归属改写为自己——锁定技无需询问，引擎在提交时自动改写。
   * 点数和 = 牌面点数（2 记 2、A 记 1、J=11、Q=12、K=13），王按所当点数，单王/对王视为无穷（必触发）。
   * 适用于一切打出（含插队/狂吠/翻面接/茄汤强制）；不触发实际出牌者的技能（含海棠洄游切换），
   * 接牌轮转从自己下家继续（原出牌者不跳过、仍可接），巨石/地坛等判定对自己生效，
   * 轮末无人再接则自己获得牌权，打完手牌仍按实际出牌者获胜；自己淘汰后失效。
   */
  exciteOnPlay?: boolean;
  /**
   * 两倍（玊）：初始手牌、手牌上限、所有从牌堆的摸牌数量均为正常数量的两倍——
   * 初始手牌 = 发牌张数 ×2（先手 6×2=12、其余 5×2=10）；手牌上限 20×2=40（超出照常淘汰）；
   * 轮末补摸/插队受害者 X/无名加牌 X/旺旺 3/回味 n/隐匿重铸等一切经 drawCards 的摸牌 ×2；
   * 拿回特定牌（takeRevealed 判定牌摸回）与别人给牌（giveRevealed 展示区拿牌）不翻倍。
   */
  doubleSupply?: boolean;
  /**
   * 呕哑（玊）：轮到自己接牌时，可打出包含桌面那一手牌全部实际点数的任意合法牌型，
   * 无视管牌规则（判定见 combos.ouYaCovers；单王/对王桌面无实际点数不可发动）。
   * 引擎在 playCards 校验层放行，其余流程（获胜/判定/插队）照常。
   */
  ouYa?: boolean;
  /**
   * 吐饼（兰登·费夫 R.F，引擎级机制 + 三段询问，无需角色钩子）：
   * ①吃饼 = 特殊响应、不算出牌（2026-10-05 用户定稿措辞）——每次有人打出牌后（物理出牌者 ≠ 自己，
   *   含插队/狂吠连压每一手/翻面接等一切打出；归属改写不改物理出牌者），若手中有「恰好接上」的牌
   *   （combos.isExactFollow：点数恰好差一级，正序 +1/倒序 −1；2 压 A、倒序 A 响应 2 算恰好；
   *   2 压其他牌/炸弹张数更多/单王/对王/首席 Q 压一切类打出不算；王按所当点数），
   *   最先询问（先于狂吠/插队），每手限问一次、弃权/超时放弃本手、无次数上限。
   *   同意后三段：自选一组恰好牌公开亮出（牌留手中）→ 从牌堆摸 N 张（N = 桌面那手牌张数，
   *   超上限照常淘汰）→ 自选手中 N 张倒置成饼（公开张数、对包括自己所有人只露牌背、
   *   永久留桌，任何技能不可拿回/弃置）。饼数 ≥ 手牌数 → 立即获胜（别人打光手牌先胜）。
   *   桌面归属不变；轮末无人再接则自己获得起牌权（有人接上则正常更迭）；
   *   吃过饼后同一手轮到自己不能再过（只能打 2/炸弹，没有则自动过）。
   * ②无牌权限制：响应他人时只能直接打 2（正序单2/对2、倒序镜像单3/对3）或炸弹，
   *   其余恰好接上的牌只能靠吃饼；有牌权（领出/轮末得权）出任何牌不受限。
   * ③阿色抽你限制适用（算响应）、红楼梦禁出期间不可吃、起牌（无桌面）不可吃。
   */
  pancake?: boolean;
  /**
   * 贪婪（阿摩，锁定技无需询问）：
   * ①初始手牌 = 2×全场人数张（X = 全场人数含自己；先手/后手同，不沿用「先手多 1」），
   *   在 start 发牌处直接按 2X 发。
   * ②手牌上限 30（超出照常淘汰）。
   * ③每次普通主动出牌后摸 1 张（从牌堆，牌堆空走弃牌洗回）：出完最后一张先判获胜不摸；
   *   再问补打（playSideCard）不算；被惰戈亢奋归属改写（tableOwnerId ≠ 自己）不算——
   *   那手牌视作惰戈打出（2026-10-05 用户确认）。
   */
  greedy?: boolean;
  /**
   * 耀武（阿摩，锁定技无需询问）：手牌覆盖 A~K 全部 13 个点数（3..15，含 2）→ 立即获胜
   * （combos.yaoWuCovers：每张王补一个缺的点数，王视作任意点数仅用于此判定）。
   * 每次手牌变化后立即判定：发牌后（start 里 phase 置 playing 后统一判）、一切 rawDraw 摸牌后、
   * 拿回/收下展示牌后（moveRevealedToHand）、别人给牌后（facade giveTo，如骚骚换牌）；
   * 满足即 finishGame（2026-10-05 用户确认：任何时刻满足立即获胜，含发牌时）。
   */
  yaoWu?: boolean;
  /**
   * 血压（硝烟，锁定技）：手牌 ≥8 时「其余人的技能不能对你生效」——引擎守卫：
   * ①技能目标选择（suspend 的 targetCandidates）自动过滤保护者；
   * ②禁打（诅咒/罚站）对保护者无效（动态：摸到 ≥8 立即解除禁打）；
   * ③亢奋归属改写、无名加牌等引擎内自动锁定不生效；
   * ④其余角色钩子（旺旺/回味/巨石/答疑改判/五连鞭/压腿/尖叫发牌等）用 facade bpProtected 自查目标。
   * 增益类技能同样被挡（2026-10-06 用户确认「全挡」）。
   */
  bloodPressure?: boolean;
  /**
   * 神秘（辛歼，锁定技，2026-10-06 用户定稿）：
   * ①独立牌堆——游戏开始时获得额外 54 张（一整副：3..2 各 4 + 大小王，id 独立于公共三副）作为其专属牌堆，
   *   他的摸牌一律从独立牌堆摸；他的弃牌（打出/技能弃置/淘汰清空等一切含他牌面 id 的弃置）进独立弃牌堆；
   *   独立牌堆摸空时独立弃牌堆洗回继续自己用（不参与公共洗回，公共洗回也不含他的牌）；
   *   两堆都空则无牌可摸。独立牌堆/弃牌堆张数只对他自己可见。
   * ②初始手牌数自选——开局发牌时询问（先手 5-7、其他 4-6；超时取正常张数 6/5）；
   *   handsOverride 测试模式跳过询问。
   * ③摸牌阶段自选——轮末他获得牌权时询问摸 1 或 2 张（超时默认 1）；
   *   技能导致的摸牌（旺旺/无名加牌等）不在其列，照常张数。
   * ④手牌数不可探查——快照对其他玩家隐藏他的手牌数（客户端显示 ??）。
   * ⑤留 2 豁免——可以以单 2/对 2（倒序单 3/对 3）打完手牌（含代打/翻面接等一切打出路径）。
   */
  mystic?: boolean;
  /**
   * 障目（辛歼，非锁定被动）：当别人的非锁定指向性技能锁定他时（目标确定后、生效前，引擎门控），
   * 施放者须猜他的手牌数（1-20；超时算猜错）：
   * 猜错 → 此次技能失效、不消耗次数、本回合不能再对其他人发动该技能（对辛歼重试可再猜）；
   * 猜中 → 技能照常生效且辛歼自选摸 1-3 张（超时默认 1）。
   * 血压守卫：施放者受高血压保护（手牌 ≥8 的硝烟）时障目不触发。
   * 门控由引擎提供（facade zhangMuCheck），各非锁定指向性技能在目标确定后调用。
   */
  zhangMu?: boolean;
}

export type RoleRegistry = Map<string, RoleDef>;
