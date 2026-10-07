// Socket.IO 协议：事件名常量 + 载荷类型（两端共用，避免字符串漂移）

export const CLIENT_EVENTS = {
  roomCreate: 'room:create',
  roomJoin: 'room:join',
  roomRejoin: 'room:rejoin',
  roleSelect: 'role:select',
  roomReady: 'room:ready',
  roomStart: 'room:start',
  roomRematch: 'room:rematch',
  roomLeave: 'room:leave',
  roomAddBot: 'room:addBot',
  roomRemoveBot: 'room:removeBot',
  gamePlay: 'game:play',
  gamePass: 'game:pass',
  gameUseSkill: 'game:useSkill',
  scoreList: 'score:list',
} as const;

export const SERVER_EVENTS = {
  roomUpdated: 'room:updated',
  snapshot: 'game:snapshot',
  event: 'game:event',
  error: 'game:error',
  scoreList: 'score:list',
  skillAsk: 'game:skill-ask',
} as const;

/** ack 回调的统一返回：ok:true 带数据，ok:false 带中文错误 */
export type AckResult<T extends object = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };

export interface RoomCreatePayload {
  name: string;
}

export interface RoomCreateAck {
  code: string;
  playerId: string;
  secret: string;
}

export interface RoomJoinPayload {
  code: string;
  name: string;
}

export interface RoomRejoinPayload {
  code: string;
  playerId: string;
  secret: string;
}

export interface RoleSelectPayload {
  roleId: string;
}

export interface ReadyPayload {
  ready: boolean;
}

/** 房主移除指定人机座位 */
export interface RoomRemoveBotPayload {
  playerId: string;
}

export interface PlayPayload {
  cardIds: number[];
  /** 端庄（轴承）翻面：翻面的桌面牌 id（缺省 = 普通出牌） */
  flippedCardId?: number;
}

/** 主动技 / 技能询问回答（有 askId = 回答询问；否则 = 发动主动技） */
export interface SkillUsePayload {
  askId?: string;
  skillId?: string;
  choice?: string;
  cardIds?: number[];
  targetPlayerId?: string;
  /** 障目（辛歼）猜对方手牌数（1-20） */
  guess?: number;
}

/** 大厅/房间公开状态（所有成员可见，广播用） */
export interface RoomPlayerView {
  id: string;
  name: string;
  roleId: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  /** 人机（白板无角色，房主可加入/移除） */
  isBot: boolean;
}

export interface RoomState {
  code: string;
  phase: 'lobby' | 'playing' | 'finished';
  hostId: string;
  players: RoomPlayerView[];
  winnerId: string | null;
  scoreDeltas: Record<string, number> | null;
  /** 跨局累计分 */
  totals: Record<string, number>;
  rematchVotes: string[];
}

/** 一局战绩记录（落盘用）；winnerId 为 null 表示流局 */
export interface GameRecord {
  at: string;
  roomId: string;
  winnerId: string | null;
  players: { id: string; name: string; roleId: string; score: number }[];
}

export interface ScoreListAck {
  records: GameRecord[];
}
