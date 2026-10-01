// 规则配置：引擎的所有判定都读这里，无硬编码。定稿规则 = defaultRules。
export interface RuleConfig {
  deck: { count: number };
  jokers: {
    areWild: boolean;
    /** 王能否当单张打出（定稿：不能） */
    aloneAsSingle: boolean;
    /** 王能否补对子（7+鬼=对7） */
    completePair: boolean;
    fillStraight: boolean;
    fillConsecutivePairs: boolean;
    fillBomb: boolean;
    /** 每个组合至少几张真牌（定稿：1，纯王组合不合法） */
    minRealCardsInCombo: number;
  };
  ranks: { min: number; max: number };
  straight: {
    minLength: number;
    maxLength: number;
    exclude: number[];
    wildResolution: 'gapsUpDown' | 'gapsUpOnly' | 'gapsDownOnly';
  };
  consecutivePairs: { minPairs: number; maxPairs: number; exclude: number[] };
  bomb: { minSize: number; maxSize: number; threeOfAKindIsBomb: boolean; compare: 'sizeThenRank' };
  follow: {
    singlePair: { strictPlusOne: boolean; twoBeatsAll: boolean };
    longCombo: { sameLength: boolean; startWithinPrevWindow: boolean };
    voluntaryPassAllowed: boolean;
  };
  pass: { drawOnPass: number };
  roundEnd: { lastPlayerDraws: boolean; drawCount: number; lastPlayerLeads: boolean };
  deal: {
    leaderCards: number;
    others: number;
    leader: 'previousWinner' | 'random';
    initialLeader: 'random';
  };
  win: { immediateOnEmptyHand: boolean };
  scoring: { winner: 'playersMinus1'; loser: number; cumulative: boolean };
  players: { min: number; max: number };
  /** 手牌上限（定稿：20，超过直接淘汰） */
  hand: { limit: number; overLimitEliminate: boolean };
  timeout: { turnMs: number; disconnectedAutoPassMs: number; skillAskMs: number };
}

/** 定稿规则（与用户逐条确认） */
export const defaultRules: RuleConfig = {
  deck: { count: 3 },
  jokers: {
    areWild: true,
    aloneAsSingle: false,
    completePair: true,
    fillStraight: true,
    fillConsecutivePairs: true,
    fillBomb: true,
    minRealCardsInCombo: 1,
  },
  ranks: { min: 3, max: 15 },
  straight: {
    minLength: 3,
    maxLength: 12,
    exclude: [15], // 2 不进顺子
    wildResolution: 'gapsUpDown',
  },
  consecutivePairs: { minPairs: 2, maxPairs: 6, exclude: [15] },
  bomb: { minSize: 3, maxSize: 12, threeOfAKindIsBomb: true, compare: 'sizeThenRank' },
  follow: {
    singlePair: { strictPlusOne: true, twoBeatsAll: true },
    longCombo: { sameLength: true, startWithinPrevWindow: true },
    voluntaryPassAllowed: true,
  },
  pass: { drawOnPass: 0 },
  roundEnd: { lastPlayerDraws: true, drawCount: 1, lastPlayerLeads: true },
  deal: { leaderCards: 6, others: 5, leader: 'previousWinner', initialLeader: 'random' },
  win: { immediateOnEmptyHand: true },
  scoring: { winner: 'playersMinus1', loser: -1, cumulative: true },
  players: { min: 2, max: 6 },
  hand: { limit: 20, overLimitEliminate: true },
  timeout: { turnMs: 30000, disconnectedAutoPassMs: 15000, skillAskMs: 15000 },
};

/** 校验配置合法性，返回中文错误列表（空 = 合法） */
export function validateRules(cfg: RuleConfig): string[] {
  const errs: string[] = [];
  const { min, max } = cfg.players;
  if (!(min >= 2 && max >= min && max <= 10)) errs.push('玩家数范围不合法');
  if (cfg.deck.count < 1) errs.push('牌库副数至少为 1');
  if (cfg.straight.minLength < 3) errs.push('顺子长度至少为 3');
  if (cfg.bomb.minSize < 3) errs.push('炸弹至少 3 张');
  if (cfg.hand.limit < 1) errs.push('手牌上限至少为 1');
  if (cfg.hand.limit < Math.max(cfg.deal.leaderCards, cfg.deal.others))
    errs.push('手牌上限不能小于发牌张数');
  const total = cfg.deck.count * 54;
  const needMax = cfg.players.max * Math.max(cfg.deal.leaderCards, cfg.deal.others);
  if (total < needMax) errs.push(`牌库 ${total} 张不够 ${max} 人发牌`);
  if (cfg.straight.exclude.includes(15) === false && cfg.straight.maxLength > 14 - cfg.ranks.min + 1)
    errs.push('顺子最大长度超出点数范围');
  return errs;
}
