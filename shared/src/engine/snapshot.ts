import type { Card } from '../cards';
import type { AskKind } from '../roles/types';
import type { Combo } from './combos';

export interface SnapshotPlayer {
  id: string;
  name: string;
  roleId: string;
  handCount: number;
  /** 仅查看者本人的手牌（其他人 null） */
  hand: Card[] | null;
  connected: boolean;
  /** 已淘汰（座位保留但跳过） */
  eliminated: boolean;
  roleState: unknown;
}

/** 快照中的询问元信息（完整载荷经 game:skill-ask 定向发给被问者） */
export interface PendingAskInfo {
  askId: string;
  playerId: string;
  kind: AskKind;
  prompt: string;
  timeoutMs: number;
}

export interface GameSnapshot {
  phase: 'playing' | 'finished';
  players: SnapshotPlayer[];
  deckCount: number;
  /** 弃牌堆张数（被压过的牌） */
  discardCount: number;
  /** 翻牌展示区（判定牌等公开牌，所有人可见；动作内须清空） */
  revealed: Card[];
  table: Combo | null;
  /** 明置桌旁的边牌（再问补打等：随当前一手牌一起弃置，公开） */
  tableSide: Card[];
  /** 是否倒序（海棠洄游：出牌即切换，每轮恢复正序） */
  orderReversed: boolean;
  turnPlayerId: string | null;
  roundLeaderId: string;
  winnerId: string | null;
  scoreDeltas: Record<string, number> | null;
  /** 跨局累计分 */
  totals: Record<string, number>;
  /** 待处理的技能询问（可能为 null） */
  pendingAsk: PendingAskInfo | null;
}
