// 全局状态（zustand）：屏幕路由 + 房间状态 + 快照 + 本地手牌选择 + 播报。
// 服务端全权：所有动作都只是发 socket 事件，界面渲染服务端广播的状态。
import { create } from 'zustand';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  cardColor,
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
  /** 本轮每人最近一次打出的牌（打出者面前保持可见，轮末清除进弃牌堆） */
  roundPlays: Record<string, Combo>;
  /** 明置桌旁的边牌（再问补打等，随当前一手牌一起弃置） */
  tableSideCards: Card[];
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

  // 生命周期
  init(): void;
  toast(kind: ToastItem['kind'], text: string): void;
  dismissToast(id: number): void;
  setScreen(screen: Screen): void;

  // 大厅/房间
  createRoom(): Promise<boolean>;
  joinRoom(code: string): Promise<boolean>;
  leaveRoom(): void;
  selectRole(roleId: string): Promise<void>;
  setReady(ready: boolean): Promise<void>;
  startGame(): Promise<void>;
  rematch(): Promise<void>;
  fetchScores(): Promise<void>;

  // 出牌
  toggleSelect(cardId: number): void;
  clearSelection(): void;
  play(): Promise<void>;
  pass(): Promise<void>;

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
  roundPlays: {},
  tableSideCards: [],
  skillAsk: null,
  revealed: null,
  handOrder: null,
  handOrderFor: '',
  organize: false,
  enteredCardIds: [],

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
      roundPlays: {},
      enteredCardIds: [],
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

  async play() {
    const { selectedCardIds } = get();
    if (selectedCardIds.length === 0) return;
    const res = await emitAck(CLIENT_EVENTS.gamePlay, { cardIds: selectedCardIds });
    if (res.ok) set({ selectedCardIds: [] });
    else get().toast('error', (res as { error: string }).error);
  },

  async pass() {
    const res = await emitAck(CLIENT_EVENTS.gamePass);
    if (res.ok) set({ selectedCardIds: [] });
    else get().toast('error', (res as { error: string }).error);
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
    // 弹窗只在快照 pendingAsk 为空时关闭（applySnapshot）。
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
      set({ tablePlayerId: null, passedAt: {}, roundPlays: {}, tableSideCards: [] });
    }
    // 对局结束回到房间（再来一局全员投票通过）→ 清空对局状态，回房间重新选角色/准备
    if (prev && prev.phase === 'finished' && room.phase === 'lobby') {
      cancelRevealClear();
      set({
        snap: null,
        skillAsk: null,
        revealed: null,
        roundPlays: {},
        tableSideCards: [],
        selectedCardIds: [],
        organize: false,
        enteredCardIds: [],
        tablePlayerId: null,
        passedAt: {},
      });
    }
  },

  applySnapshot(snap) {
    const { selectedCardIds, myId, handOrder, handOrderFor, revealed, snap: prevSnap, enteredCardIds } = get();
    const myHand = snap.players.find((p) => p.id === myId)?.hand ?? [];
    const myHandIds = new Set(myHand.map((c) => c.id));

    // 新摸入我手牌的牌 id（旧快照手牌差集）；首局初始快照跳过——发牌不播入场动画
    let entered = enteredCardIds;
    const prevHand = prevSnap?.players.find((p) => p.id === myId)?.hand;
    if (prevHand) {
      const prevIds = new Set(prevHand.map((c) => c.id));
      const fresh = myHand.filter((c) => !prevIds.has(c.id)).map((c) => c.id);
      if (fresh.length > 0) entered = [...entered, ...fresh];
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
          purpose: revealedNext?.purpose ?? '翻牌',
        };
      }
    }

    // 询问已了结（快照里不再挂起）→ 关闭弹窗
    set({
      snap,
      tableSideCards: snap.tableSide,
      selectedCardIds: selectedCardIds.filter((id) => myHandIds.has(id)),
      skillAsk: snap.pendingAsk ? get().skillAsk : null,
      revealed: revealedNext,
      handOrder: order,
      handOrderFor: myId,
      enteredCardIds: entered,
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
          roundPlays: { ...s.roundPlays, [e.playerId as string]: e.combo as Combo },
        }));
        scheduleRevealClear(get().revealed?.cards.length ?? 0);
        break;
      case 'table:attributed': {
        // 桌面一手牌归属改写（再问/亢奋）：展示移到新归属者名下
        const from = e.fromPlayerId as string;
        const to = e.playerId as string;
        set((s) => {
          const plays = { ...s.roundPlays };
          delete plays[from];
          plays[to] = e.combo as Combo;
          return { tablePlayerId: to, roundPlays: plays };
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
        // 本轮牌全部进弃牌堆：清空打出者面前的展示
        set({ tablePlayerId: null, passedAt: {}, roundPlays: {}, tableSideCards: [] });
        scheduleRevealClear(get().revealed?.cards.length ?? 0);
        const last = room?.players.find((p) => p.id === e.lastPlayerId);
        if (last) toast('info', `无人能管，${last.name} 摸了 ${e.drew} 张牌继续出`);
        break;
      }
      case 'skill:triggered': {
        const role = getRole(e.roleId as string);
        const skillName = role?.skills.find((s) => s.id === e.skillId)?.name ?? (e.skillId as string);
        toast('skill', `【${skillName}】${e.text as string}`);
        break;
      }
      case 'player:eliminated': {
        scheduleRevealClear(get().revealed?.cards.length ?? 0);
        const name = room?.players.find((p) => p.id === e.playerId)?.name ?? (e.playerId as string);
        toast('info', STR.game.eliminatedToast.replace('{name}', name).replace('{reason}', String(e.reason)));
        break;
      }
      case 'cards:revealed': {
        // 公开判定牌：追加进展示区流（同 id 去重），渲染层做逐张入场动画
        // 不同用途的翻牌流（如茄汤亮牌 → 黑脸判定）不混合：新流开始先清空旧的
        const cards = (e.cards as Card[] | undefined) ?? [];
        if (cards.length > 0) {
          cancelRevealClear(); // 新翻牌流开始，作废上一次的延迟清除
          set((s) => {
            const purpose = (e.purpose as string | undefined) ?? s.revealed?.purpose ?? '翻牌';
            const base = s.revealed && s.revealed.purpose !== purpose ? [] : (s.revealed?.cards ?? []);
            const seen = new Set(base.map((c) => c.id));
            const fresh = cards.filter((c) => !seen.has(c.id));
            if (fresh.length === 0) return {};
            return {
              revealed: {
                cards: [...base, ...fresh],
                purpose,
              },
            };
          });
        }
        break;
      }
      case 'turn:started':
        scheduleRevealClear(get().revealed?.cards.length ?? 0);
        break;
      case 'game:ended': {
        cancelRevealClear();
        set({ revealed: null, roundPlays: {} });
        const winner = room?.players.find((p) => p.id === e.winnerId);
        if (winner) toast('info', `${winner.name} 获胜！`);
        else toast('info', '流局：无人能出牌');
        break;
      }
      default:
        break;
    }
  },
}));
