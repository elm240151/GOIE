// 全局状态（zustand）：屏幕路由 + 房间状态 + 快照 + 本地手牌选择 + 播报。
// 服务端全权：所有动作都只是发 socket 事件，界面渲染服务端广播的状态。
import { create } from 'zustand';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  cardColor,
  defaultRules,
  getRole,
  isJoker,
  type Card,
  type Combo,
  type GameRecord,
  type GameSnapshot,
  type RoomState,
  type ScoreListAck,
  type SkillAsk,
  type SkillUsePayload,
} from '@gdys/shared';
import { loadAllRolesClient } from '@gdys/shared/roles/loader.client';
import { emitAck, getSocket } from './socket';
import { LS_IDENTITY, LS_NAME, STR } from './strings';

export type Screen = 'lobby' | 'room' | 'game' | 'scoreboard';

export type HandSortMode = 'rank' | 'suit' | 'color';

/** 默认排序：点数升序、王最后、同点数按花色 */
function sortByRank(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => {
    if (isJoker(a) !== isJoker(b)) return isJoker(a) ? 1 : -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.suit - b.suit;
  });
}

function sortBySuit(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => {
    if (isJoker(a) !== isJoker(b)) return isJoker(a) ? 1 : -1;
    if (a.suit !== b.suit) return a.suit - b.suit;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return 0;
  });
}

function sortByColor(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => {
    const ca = cardColor(a) === 'red' ? 0 : 1;
    const cb = cardColor(b) === 'red' ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (isJoker(a) !== isJoker(b)) return isJoker(a) ? 1 : -1;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.suit - b.suit;
  });
}

const SORT_FNS: Record<HandSortMode, (cards: readonly Card[]) => Card[]> = {
  rank: sortByRank,
  suit: sortBySuit,
  color: sortByColor,
};

function orderKey(playerId: string): string {
  return `gdys-handorder-${playerId}`;
}

function loadOrder(playerId: string): number[] | null {
  if (!playerId) return null;
  try {
    const raw = localStorage.getItem(orderKey(playerId));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return v as number[];
  } catch {
    /* 忽略损坏数据 */
  }
  return null;
}

export interface RejoinIdentity {
  roomId: string;
  playerId: string;
  secret: string;
}

export interface ToastItem {
  id: number;
  kind: 'info' | 'skill' | 'error';
  text: string;
}

interface AppStore {
  screen: Screen;
  connected: boolean;
  playerName: string;
  identity: RejoinIdentity | null;
  room: RoomState | null;
  snap: GameSnapshot | null;
  myId: string;
  selectedCardIds: number[];
  toasts: ToastItem[];
  records: GameRecord[] | null;
  /** 桌面上当前这手牌是谁出的（出牌气泡用） */
  tablePlayerId: string | null;
  /** 最近谁过了（气泡用，值为过牌时间戳） */
  passedAt: Record<string, number>;
  /** 本轮全部出牌按时间序（中央暂存区 + 出牌记录条共用；轮末统一弃置时清空） */
  roundPlayLog: { playerId: string; combo: Combo }[];
  /** 本轮判定翻出的牌（中央暂存区保留到回合结束，回合结束统一弃置） */
  judgedCards: Card[];
  /** 明置桌旁的边牌（再问补打等，随当前一手牌一起弃置） */
  tableSideCards: Card[];
  /** 弃牌暂存区（本回合公开弃置的牌，谁弃的、弃了什么全场可见；轮末进弃牌堆） */
  stagedDiscards: { playerId: string; cards: Card[] }[];
  /** 服务端发给我的技能询问（完整载荷，弹窗用） */
  skillAsk: SkillAsk | null;
  /** 场上公开亮出的判定牌（逐张动画展示区，来自 cards:revealed 事件流） */
  revealed: { cards: Card[]; purpose: string } | null;
  /** 我的手牌显示顺序（cardId 数组；null = 默认排序）。按玩家持久化到 localStorage */
  handOrder: number[] | null;
  /** handOrder 所属的 playerId（换房间自动重载） */
  handOrderFor: string;
  /** 整理手牌模式（点两张牌交换位置） */
  organize: boolean;
  /** 新摸入我手牌的牌 id（入场动画标记；只增不删，跨局清空——每局牌 id 重新编号） */
  enteredCardIds: number[];
  /** 回合序号（turn:started 事件自增）：同一玩家连续两轮持牌权时驱动倒计时重置 */
  turnSeq: number;
  /** 最近谁摸了牌（值为摸牌时间戳，座位手牌数 pop 动画用） */
  drawnAt: Record<string, number>;
  /** 诅咒本回合生效的玩家 id（地坛）：其余被诅咒者是下一轮生效（半透明标） */
  curseActiveIds: string[];
  /** 诅咒基线所属的起牌者：turn:started 置空，下一次快照按当前 cursedPlayerIds 重取基线 */
  curseBaselineLeader: string;
  /** 顶部大事件横幅（终局/淘汰，2.6s 自消） */
  banner: { kind: 'win' | 'draw' | 'eliminated'; text: string } | null;
  /** 最近淘汰时间戳（座位抖动动画用） */
  eliminatedAt: Record<string, number>;
  /** 端庄（轴承）翻面：选中的翻面牌 id（须是当前桌面一手牌中的牌；快照桌面变化自动清空） */
  flippedCardId: number | null;
  /** 窃笑（轴承）：私密查看到的手牌弹窗（服务端 skill:peek 定向发我） */
  peekedHand: { targetId: string; cards: Card[] } | null;

  // 生命周期
  init(): void;
  toast(kind: ToastItem['kind'], text: string): void;
  dismissToast(id: number): void;
  dismissBanner(): void;
  setScreen(screen: Screen): void;

  // 大厅/房间
  createRoom(): Promise<boolean>;
  joinRoom(code: string): Promise<boolean>;
  leaveRoom(): void;
  selectRole(roleId: string): Promise<void>;
  setReady(ready: boolean): Promise<void>;
  startGame(): Promise<void>;
  rematch(): Promise<void>;
  addBot(): Promise<void>;
  removeBot(playerId: string): Promise<void>;
  fetchScores(): Promise<void>;

  // 出牌
  toggleSelect(cardId: number): void;
  clearSelection(): void;
  toggleFlipSelect(cardId: number): void;
  play(): Promise<void>;
  pass(): Promise<void>;
  closePeek(): void;

  // 技能
  useSkillAction(skillId: string): Promise<void>;
  answerSkill(answer: SkillUsePayload): Promise<void>;

  // 手牌整理
  toggleOrganize(): void;
  sortHand(mode: HandSortMode): void;
  swapHand(aId: number, bId: number): void;

  // 服务端广播落地
  applyRoom(room: RoomState): void;
  applySnapshot(snap: GameSnapshot): void;
  applyEvent(e: { type: string } & Record<string, unknown>): void;
}

let toastSeq = 0;

/** 手牌上限（与引擎 checkHandLimit 同口径：贪婪 30 → 两倍 40 → 默认 20） */
export function handLimitOf(roleId: string): number {
  const role = getRole(roleId);
  if (role?.greedy) return 30;
  if (role?.doubleSupply) return defaultRules.hand.limit * 2;
  return defaultRules.hand.limit;
}

/** 公开翻牌展示区的延迟清除定时器（留出逐张亮出的动画时间） */
let revealClearTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRevealClear(n: number) {
  if (revealClearTimer) clearTimeout(revealClearTimer);
  revealClearTimer = setTimeout(() => {
    useStore.setState({ revealed: null });
  }, 1400 + Math.min(n, 8) * 450);
}

function cancelRevealClear() {
  if (revealClearTimer) {
    clearTimeout(revealClearTimer);
    revealClearTimer = null;
  }
}

/** 别人摸牌 toast 的延迟缓冲：轮末摸牌的「摸了 N 张」与 round:ended 的「继续出」重复，
 *  延迟 80ms 播出，round:ended 到达时撤销（事件批量顺序：cards:drawn 在前、round:ended 在后） */
let pendingDrawnToast: { playerId: string; timer: ReturnType<typeof setTimeout> } | null = null;

function cancelDrawnToast() {
  if (pendingDrawnToast) {
    clearTimeout(pendingDrawnToast.timer);
    pendingDrawnToast = null;
  }
}

function loadIdentity(): RejoinIdentity | null {
  try {
    const raw = localStorage.getItem(LS_IDENTITY);
    if (!raw) return null;
    const v = JSON.parse(raw) as RejoinIdentity;
    if (v && typeof v.roomId === 'string' && typeof v.playerId === 'string' && typeof v.secret === 'string') return v;
  } catch {
    /* 忽略损坏数据 */
  }
  return null;
}

export const useStore = create<AppStore>((set, get) => ({
  screen: 'lobby',
  connected: false,
  playerName: localStorage.getItem(LS_NAME) ?? '',
  identity: loadIdentity(),
  room: null,
  snap: null,
  myId: loadIdentity()?.playerId ?? '',
  selectedCardIds: [],
  toasts: [],
  records: null,
  tablePlayerId: null,
  passedAt: {},
  roundPlayLog: [],
  judgedCards: [],
  tableSideCards: [],
  stagedDiscards: [],
  skillAsk: null,
  revealed: null,
  handOrder: null,
  handOrderFor: '',
  organize: false,
  enteredCardIds: [],
  turnSeq: 0,
  drawnAt: {},
  curseActiveIds: [],
  curseBaselineLeader: '',
  banner: null,
  eliminatedAt: {},
  flippedCardId: null,
  peekedHand: null,

  init() {
    loadAllRolesClient();
    const socket = getSocket();

    socket.on('connect', () => {
      set({ connected: true });
      const { identity } = get();
      if (identity) {
        // 自动重连恢复座位
        void emitAck(CLIENT_EVENTS.roomRejoin, identity).then((res) => {
          if (!res.ok) {
            localStorage.removeItem(LS_IDENTITY);
            set({ identity: null, myId: '', screen: 'lobby' });
            get().toast('error', (res as { error: string }).error);
          }
        });
      }
    });
    socket.on('disconnect', () => set({ connected: false }));

    socket.on(SERVER_EVENTS.roomUpdated, (room: RoomState) => {
      get().applyRoom(room);
    });
    socket.on(SERVER_EVENTS.snapshot, (snap: GameSnapshot) => {
      get().applySnapshot(snap);
    });
    socket.on(SERVER_EVENTS.event, (e: { type: string } & Record<string, unknown>) => {
      get().applyEvent(e);
    });
    socket.on(SERVER_EVENTS.skillAsk, (ask: SkillAsk) => {
      set({ skillAsk: ask });
    });
    socket.on(SERVER_EVENTS.error, (msg: unknown) => {
      get().toast('error', typeof msg === 'string' ? msg : String(msg));
    });
  },

  toast(kind, text) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 4000 : 2600);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  dismissBanner() {
    set({ banner: null });
  },
  setScreen(screen) {
    set({ screen });
  },

  async createRoom() {
    const name = get().playerName.trim();
    if (!name) return false;
    const res = await emitAck<{ code: string; playerId: string; secret: string }>(CLIENT_EVENTS.roomCreate, { name });
    if (!res.ok) {
      get().toast('error', (res as { error: string }).error);
      return false;
    }
    const identity = { roomId: res.code, playerId: res.playerId, secret: res.secret };
    localStorage.setItem(LS_NAME, name);
    localStorage.setItem(LS_IDENTITY, JSON.stringify(identity));
    set({ identity, myId: res.playerId, selectedCardIds: [], screen: 'room' });
    return true;
  },

  async joinRoom(code) {
    const name = get().playerName.trim();
    if (!name) return false;
    const res = await emitAck<{ code: string; playerId: string; secret: string }>(CLIENT_EVENTS.roomJoin, { code, name });
    if (!res.ok) {
      get().toast('error', (res as { error: string }).error);
      return false;
    }
    const identity = { roomId: res.code, playerId: res.playerId, secret: res.secret };
    localStorage.setItem(LS_NAME, name);
    localStorage.setItem(LS_IDENTITY, JSON.stringify(identity));
    set({ identity, myId: res.playerId, selectedCardIds: [], screen: 'room' });
    return true;
  },

  leaveRoom() {
    void emitAck(CLIENT_EVENTS.roomLeave).catch(() => undefined);
    localStorage.removeItem(LS_IDENTITY);
    set({
      identity: null,
      myId: '',
      room: null,
      snap: null,
      selectedCardIds: [],
      skillAsk: null,
      revealed: null,
      organize: false,
      roundPlayLog: [],
      judgedCards: [],
      enteredCardIds: [],
      turnSeq: 0,
      flippedCardId: null,
      peekedHand: null,
      screen: 'lobby',
    });
  },

  async selectRole(roleId) {
    const res = await emitAck(CLIENT_EVENTS.roleSelect, { roleId });
    if (!res.ok) get().toast('error', (res as { error: string }).error);
  },

  async setReady(ready) {
    const res = await emitAck(CLIENT_EVENTS.roomReady, { ready });
    if (!res.ok) get().toast('error', (res as { error: string }).error);
  },

  async startGame() {
    const res = await emitAck(CLIENT_EVENTS.roomStart);
    if (!res.ok) get().toast('error', (res as { error: string }).error);
  },

  async rematch() {
    const res = await emitAck(CLIENT_EVENTS.roomRematch);
    if (!res.ok) get().toast('error', (res as { error: string }).error);
  },

  async addBot() {
    const res = await emitAck(CLIENT_EVENTS.roomAddBot);
    if (!res.ok) get().toast('error', (res as { error: string }).error);
  },

  async removeBot(playerId) {
    const res = await emitAck(CLIENT_EVENTS.roomRemoveBot, { playerId });
    if (!res.ok) get().toast('error', (res as { error: string }).error);
  },

  async fetchScores() {
    const res = await emitAck<ScoreListAck>(CLIENT_EVENTS.scoreList);
    if (res.ok) set({ records: res.records });
    else get().toast('error', (res as { error: string }).error);
  },

  toggleSelect(cardId) {
    set((s) => ({
      selectedCardIds: s.selectedCardIds.includes(cardId)
        ? s.selectedCardIds.filter((id) => id !== cardId)
        : [...s.selectedCardIds, cardId],
    }));
  },

  clearSelection() {
    set({ selectedCardIds: [] });
  },

  toggleFlipSelect(cardId) {
    set((s) => ({ flippedCardId: s.flippedCardId === cardId ? null : cardId }));
  },

  async play() {
    const { selectedCardIds, flippedCardId } = get();
    if (selectedCardIds.length === 0) return;
    const payload: { cardIds: number[]; flippedCardId?: number } = { cardIds: selectedCardIds };
    if (flippedCardId != null) payload.flippedCardId = flippedCardId;
    const res = await emitAck(CLIENT_EVENTS.gamePlay, payload);
    if (res.ok) set({ selectedCardIds: [], flippedCardId: null });
    else get().toast('error', (res as { error: string }).error);
  },

  async pass() {
    const res = await emitAck(CLIENT_EVENTS.gamePass);
    // 翻面选择随过牌作废（「翻面了但没接会自动翻回来」）
    if (res.ok) set({ selectedCardIds: [], flippedCardId: null });
    else get().toast('error', (res as { error: string }).error);
  },

  closePeek() {
    set({ peekedHand: null });
  },

  async useSkillAction(skillId) {
    const res = await emitAck(CLIENT_EVENTS.gameUseSkill, { skillId });
    if (res.ok) set({ selectedCardIds: [] });
    else get().toast('error', (res as { error: string }).error);
  },

  async answerSkill(answer) {
    const res = await emitAck(CLIENT_EVENTS.gameUseSkill, answer);
    // 注意：不要在这里清 skillAsk——服务端先发新快照/下一步询问事件、后回 ack，
    // ack 到达时清空会误关多阶段询问的下一步弹窗（企鹅骚骚曾因此"发动不了"）。
    // 弹窗在快照 pendingAsk 为空或不再定向我时关闭（applySnapshot）。
    if (!res.ok) get().toast('error', (res as { error: string }).error);
  },

  toggleOrganize() {
    set((s) => ({ organize: !s.organize }));
  },

  sortHand(mode) {
    const { snap, myId } = get();
    const hand = snap?.players.find((p) => p.id === myId)?.hand ?? [];
    if (hand.length === 0) return;
    const order = SORT_FNS[mode](hand).map((c) => c.id);
    localStorage.setItem(orderKey(myId), JSON.stringify(order));
    set({ handOrder: order, handOrderFor: myId });
  },

  swapHand(aId, bId) {
    const { handOrder, myId } = get();
    if (!handOrder) return;
    const a = handOrder.indexOf(aId);
    const b = handOrder.indexOf(bId);
    if (a < 0 || b < 0 || a === b) return;
    const next = [...handOrder];
    [next[a], next[b]] = [next[b]!, next[a]!];
    localStorage.setItem(orderKey(myId), JSON.stringify(next));
    set({ handOrder: next });
  },

  applyRoom(room) {
    const prev = get().room;
    const screen = get().screen;
    let nextScreen: Screen = screen;
    // 大厅 → 房间；开局/对局中刷新恢复 → 游戏桌；再来一局投票通过（finished→lobby）→ 回房间重新选角色
    if (room.phase === 'lobby') {
      nextScreen = 'room';
    } else if (screen === 'lobby' || screen === 'room') {
      nextScreen = 'game';
    }
    set({ room, screen: nextScreen });
    // 新一局开始（再来一局/重开）→ 清空桌面残留
    if (prev && prev.phase !== 'lobby' && room.phase === 'playing') {
      set({
        tablePlayerId: null,
        passedAt: {},
        roundPlayLog: [],
        judgedCards: [],
        tableSideCards: [],
        stagedDiscards: [],
        drawnAt: {},
        curseActiveIds: [],
        curseBaselineLeader: '',
        banner: null,
        eliminatedAt: {},
        flippedCardId: null,
        peekedHand: null,
      });
    }
    // 对局结束回到房间（再来一局全员投票通过）→ 清空对局状态，回房间重新选角色/准备
    if (prev && prev.phase === 'finished' && room.phase === 'lobby') {
      cancelRevealClear();
      set({
        snap: null,
        skillAsk: null,
        revealed: null,
        roundPlayLog: [],
        judgedCards: [],
        tableSideCards: [],
        stagedDiscards: [],
        selectedCardIds: [],
        organize: false,
        enteredCardIds: [],
        turnSeq: 0,
        drawnAt: {},
        curseActiveIds: [],
        curseBaselineLeader: '',
        banner: null,
        eliminatedAt: {},
        flippedCardId: null,
        peekedHand: null,
        tablePlayerId: null,
        passedAt: {},
      });
    }
  },

  applySnapshot(snap) {
    const {
      selectedCardIds,
      flippedCardId,
      myId,
      handOrder,
      handOrderFor,
      revealed,
      snap: prevSnap,
      enteredCardIds,
      curseActiveIds,
      curseBaselineLeader,
    } = get();
    const myHand = snap.players.find((p) => p.id === myId)?.hand ?? [];
    const myHandIds = new Set(myHand.map((c) => c.id));

    // 翻面选中牌已不在当前桌面（新一轮/被压/自己已出）→ 清空
    const tableCardIds = new Set(snap.table?.cards.map((c) => c.id) ?? []);
    const flipped = flippedCardId !== null && tableCardIds.has(flippedCardId) ? flippedCardId : null;

    // 新摸入我手牌的牌 id（旧快照手牌差集）；首局初始快照跳过——发牌不播入场动画
    let entered = enteredCardIds;
    const prevHand = prevSnap?.players.find((p) => p.id === myId)?.hand;
    if (prevHand) {
      const prevIds = new Set(prevHand.map((c) => c.id));
      const fresh = myHand.filter((c) => !prevIds.has(c.id)).map((c) => c.id);
      if (fresh.length > 0) entered = [...entered, ...fresh].slice(-12);
    }

    // 手牌顺序：换房间重载持久化顺序；旧顺序里不在手中的剔除，新摸到的牌按默认排序追加在末尾
    let order: number[] | null = handOrder;
    if (handOrderFor !== myId) order = loadOrder(myId);
    if (order) {
      const kept = order.filter((id) => myHandIds.has(id));
      const added = sortByRank(myHand.filter((c) => !kept.includes(c.id))).map((c) => c.id);
      order = [...kept, ...added];
    }

    // 快照翻牌池并入公开展示区（重连/观股选牌阶段也能看到判定牌）
    let revealedNext = revealed;
    if (snap.revealed.length > 0) {
      const seen = new Set((revealedNext?.cards ?? []).map((c) => c.id));
      const fresh = snap.revealed.filter((c) => !seen.has(c.id));
      if (fresh.length > 0) {
        revealedNext = {
          cards: [...(revealedNext?.cards ?? []), ...fresh],
          purpose: revealedNext?.purpose ?? STR.game.defaultRevealPurpose,
        };
      }
    }

    // 询问已了结，或挂起的询问不再定向我（如隐匿答完→阿色抽你、观股依次自选轮到别人）
    // → 关闭我的弹窗；仍定向我时保留——服务端先发快照、后发定向 game:skill-ask，
    // 多阶段询问的下一步弹窗靠随后的事件更新（过早清空会闪关闪开）
    // 诅咒生效时机（地坛）：turn:started 事件已把基线置空 → 新回合首快照按当前
    // cursedPlayerIds 重取基线（= 本回合生效集）；同一回合内新增的被诅咒者下一轮生效
    const curActive = curseBaselineLeader === snap.roundLeaderId ? curseActiveIds : snap.cursedPlayerIds;
    set({
      snap,
      tableSideCards: snap.tableSide,
      stagedDiscards: snap.stagedDiscards,
      selectedCardIds: selectedCardIds.filter((id) => myHandIds.has(id)),
      flippedCardId: flipped,
      skillAsk: snap.pendingAsk?.playerId === myId ? get().skillAsk : null,
      revealed: revealedNext,
      handOrder: order,
      handOrderFor: myId,
      enteredCardIds: entered,
      curseActiveIds: curActive,
      curseBaselineLeader: snap.roundLeaderId,
    });
  },

  applyEvent(e) {
    const { room, toast } = get();
    switch (e.type) {
      case 'cards:played':
        set((s) => ({
          tablePlayerId: e.playerId as string,
          passedAt: {},
          tableSideCards: [],
          roundPlayLog: [...s.roundPlayLog, { playerId: e.playerId as string, combo: e.combo as Combo }],
        }));
        scheduleRevealClear(get().revealed?.cards.length ?? 0);
        break;
      case 'table:attributed': {
        // 桌面一手牌归属改写（再问/亢奋）：记录末条同步改归属（同手牌不新增）
        const to = e.playerId as string;
        set((s) => {
          const log = [...s.roundPlayLog];
          const last = log[log.length - 1];
          if (last && last.combo.cards[0]!.id === (e.combo as Combo).cards[0]!.id) {
            log[log.length - 1] = { playerId: to, combo: last.combo };
          }
          return { tablePlayerId: to, roundPlayLog: log };
        });
        break;
      }
      case 'table:side':
        set((s) => ({ tableSideCards: [...s.tableSideCards, e.card as Card] }));
        break;
      case 'passed': {
        const pid = e.playerId as string;
        set((s) => ({ passedAt: { ...s.passedAt, [pid]: Date.now() } }));
        break;
      }
      case 'round:ended': {
        cancelDrawnToast(); // 轮末摸牌由 roundEndToast 播报（避免「摸了 N 张」重复）
        // 本轮牌全部进弃牌堆：清空中央暂存区与出牌记录、判定牌、弃牌暂存区
        set({ tablePlayerId: null, passedAt: {}, roundPlayLog: [], judgedCards: [], tableSideCards: [], stagedDiscards: [] });
        scheduleRevealClear(get().revealed?.cards.length ?? 0);
        const last = room?.players.find((p) => p.id === e.lastPlayerId);
        if (e.ledBy && e.ledBy !== e.lastPlayerId) {
          // 地坛取而代之：诅咒目标获得牌权，由橐驼摸牌起牌
          const banner = room?.players.find((p) => p.id === e.ledBy);
          if (banner) toast('info', STR.game.curseTakeover.replace('{name}', banner.name).replace('{n}', String(e.drew)));
        } else if (last) {
          toast('info', STR.game.roundEndToast.replace('{name}', last.name).replace('{n}', String(e.drew)));
        }
        break;
      }
      case 'skill:triggered': {
        const role = getRole(e.roleId as string);
        const skillName = role?.skills.find((s) => s.id === e.skillId)?.name ?? (e.skillId as string);
        // 引擎播报多数自带【技能名】前缀，去掉重复部分（2026-10-07 用户反馈：弹窗技能名写了两次）
        let text = e.text as string;
        const prefix = `【${skillName}】`;
        if (text.startsWith(prefix)) text = text.slice(prefix.length);
        toast('skill', STR.game.skillToast.replace('{skill}', skillName).replace('{text}', text));
        break;
      }
      case 'deck:recycled': {
        toast('info', STR.game.deckRecycled.replace('{n}', String(e.count)));
        break;
      }
      case 'skill:peek': {
        // 窃笑（轴承）：服务端定向发我的私密查看结果 → 弹窗展示目标手牌
        set({ peekedHand: { targetId: e.targetId as string, cards: e.cards as Card[] } });
        break;
      }
      case 'skill:peeked': {
        // 窃笑（轴承）：被查看者收到的定向提示（其余人不知道）
        const viewer = room?.players.find((p) => p.id === e.viewerId)?.name ?? (e.viewerId as string);
        toast('info', STR.game.peekedToast.replace('{name}', viewer));
        break;
      }
      case 'player:eliminated': {
        scheduleRevealClear(get().revealed?.cards.length ?? 0);
        const name = room?.players.find((p) => p.id === e.playerId)?.name ?? (e.playerId as string);
        toast('info', STR.game.eliminatedToast.replace('{name}', name).replace('{reason}', String(e.reason)));
        set((s) => ({
          banner: { kind: 'eliminated', text: STR.game.eliminatedBanner.replace('{name}', name) },
          eliminatedAt: { ...s.eliminatedAt, [e.playerId as string]: Date.now() },
        }));
        break;
      }
      case 'cards:revealed': {
        const cards = (e.cards as Card[] | undefined) ?? [];
        if (cards.length > 0) {
          const purpose =
            (e.purpose as string | undefined) ?? get().revealed?.purpose ?? STR.game.defaultRevealPurpose;
          // 判定牌（巨石/地坛/旺旺/黑脸等 purpose 含「判定」）：暂存到中央暂存区，回合结束统一弃置
          if (purpose.includes('判定')) {
            cancelRevealClear();
            set((s) => ({ judgedCards: [...s.judgedCards, ...cards] }));
            const revealer = room?.players.find((p) => p.id === e.playerId)?.name ?? (e.playerId as string);
            toast(
              'info',
              STR.game.revealedToast
                .replace('{name}', revealer)
                .replace('{n}', String(cards.length))
                .replace('{purpose}', purpose)
            );
            break;
          }
          // 其余公开亮牌（茄汤亮牌/观股流等）：追加进展示区流（同 id 去重），渲染层做逐张入场动画
          // 不同用途的翻牌流不混合：新流开始先清空旧的
          cancelRevealClear(); // 新翻牌流开始，作废上一次的延迟清除
          const prev = get().revealed;
          const isNewStream = !prev || prev.purpose !== purpose;
          const base = isNewStream ? [] : (prev?.cards ?? []);
          const seen = new Set(base.map((c) => c.id));
          const fresh = cards.filter((c) => !seen.has(c.id));
          if (fresh.length > 0) {
            set({ revealed: { cards: [...base, ...fresh], purpose } });
            // 新流开始才播报一次（同一用途的流式翻牌不刷屏）
            if (isNewStream) {
              const revealer = room?.players.find((p) => p.id === e.playerId)?.name ?? (e.playerId as string);
              toast(
                'info',
                STR.game.revealedToast
                  .replace('{name}', revealer)
                  .replace('{n}', String(fresh.length))
                  .replace('{purpose}', purpose)
              );
            }
          }
        }
        break;
      }
      case 'turn:started':
        set((s) => ({
          turnSeq: s.turnSeq + 1,
          curseBaselineLeader: '', // 诅咒基线失效 → 下一快照按新回合的 cursedPlayerIds 重取
        }));
        scheduleRevealClear(get().revealed?.cards.length ?? 0);
        break;
      case 'cards:drawn': {
        // 别人摸牌 toast（自己的摸牌由手牌动画反馈）；轮末摸牌会紧随 round:ended，
        // 延迟 80ms 播出并在 round:ended 撤销，避免与「无人能管…继续出」重复
        set((s) => ({ drawnAt: { ...s.drawnAt, [e.playerId as string]: Date.now() } }));
        if ((e.playerId as string) === get().myId) break;
        const drawnName = room?.players.find((p) => p.id === e.playerId)?.name ?? (e.playerId as string);
        cancelDrawnToast();
        pendingDrawnToast = {
          playerId: e.playerId as string,
          timer: setTimeout(() => {
            pendingDrawnToast = null;
            get().toast('info', STR.game.drawnToast.replace('{name}', drawnName).replace('{n}', String(e.count)));
          }, 80),
        };
        break;
      }
      case 'game:ended': {
        cancelRevealClear();
        cancelDrawnToast();
        // 胜负走顶部横幅 + 终局弹窗，不再发重复 info toast
        const winner = room?.players.find((p) => p.id === e.winnerId);
        set({
          revealed: null,
          roundPlayLog: [],
          judgedCards: [],
          banner: winner
            ? { kind: 'win', text: STR.game.winnerTitle.replace('{name}', winner.name) }
            : { kind: 'draw', text: STR.game.drawTitle },
        });
        break;
      }
      default:
        break;
    }
  },
}));
