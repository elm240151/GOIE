import type { Card } from '../cards';
import type { AskKind, HeldGroup } from '../roles/types';
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
  /** 吐饼（R.F）：倒置成饼的张数（公开张数；牌面不可见、永久留桌） */
  pancakeCount: number;
  /** 尖叫（苗条）：扣置的张数（公开；牌面只对苗条自己可见） */
  heldCount: number;
  /** 尖叫（苗条）：扣置组明细（仅查看者本人可见，其他人 null） */
  held: HeldGroup[] | null;
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
  /** 桌面一手牌的归属者（含亢奋/再问归属改写；起牌前为 null；客户端宝贝预览门控用） */
  tableOwnerId: string | null;
  /** 上一手被压的牌型（端庄情况一接上一手、预览用；起牌时 null） */
  prevTable: Combo | null;
  /** 明置桌旁的边牌（再问补打等：随当前一手牌一起弃置，公开） */
  tableSide: Card[];
  /** 端庄（轴承）翻面：桌旁翻面牌 id（渲染为牌背） */
  tableSideHidden: number[];
  /** 弃牌暂存区（2026-10-06 用户规则）：本回合（轮）内公开弃置的牌（谁弃的、弃了什么全场可见——博弈信息），
   *  轮末随桌面牌一起进弃牌堆 */
  stagedDiscards: { playerId: string; cards: Card[] }[];
  /** 是否倒序（海棠洄游：出牌即切换，每轮恢复正序） */
  orderReversed: boolean;
  /** 答疑改点（修勾）：当前桌面一手牌的判定点数被改写（牌型不变）；null = 无改写 */
  tableRankNote: { rank: number } | null;
  /** 红楼梦（地坛）：被诅咒的玩家 id（含下一轮生效中；界面展示标记） */
  cursedPlayerIds: string[];
  /** 见习（陈正）：本回合罚站不得出牌的玩家 id（界面展示标记） */
  roundBannedIds: string[];
  /** 温柔（组长）：本回合被标为「宝贝」的玩家 id（不得响应组长的出牌；界面展示标记） */
  babyIds: string[];
  /** 标宝贝者（组长本人）；宝贝响应桌面牌时与 tableOwnerId 同值即被拒 */
  babyOwnerId: string | null;
  /** 血压（硝烟）：受高血压保护的玩家 id（手牌 ≥8，其余人的技能不能对其生效；界面展示标记） */
  bpProtectedIds: string[];
  turnPlayerId: string | null;
  roundLeaderId: string;
  winnerId: string | null;
  /** 吐饼（R.F）：查看者本手吃过饼且不能过（只能打 2/炸弹；客户端禁用「过」并提示） */
  pancakeNoPass: boolean;
  scoreDeltas: Record<string, number> | null;
  /** 跨局累计分 */
  totals: Record<string, number>;
  /** 待处理的技能询问（可能为 null） */
  pendingAsk: PendingAskInfo | null;
}
