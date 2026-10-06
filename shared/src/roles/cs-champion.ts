// 角色：第六席 企鹅 —— 技能【骚骚】。
// 接牌时可以发动：给一名玩家 2 张同花色的手牌换对方 1 张，或 2 张同颜色的手牌换对方 2 张
// （自选拿对方的牌）。同花色也算同颜色：同花色给牌时可自由选择换对方 1 张还是 2 张。
// 换牌取代出牌阶段、视为过牌（引擎 endTurn）：
// 其余人全过则本轮结束（最后出牌者摸 1 张并起新回合，2 人局即对方直接摸 1 张起新回合），
// 否则轮到下家正常接牌。
import { cardColor } from '../cards';
import type { HookContext, HookResult, RoleDef } from './types';

interface CsState {
  /** 换牌中间态：自己给出的两张牌、模式（1 = 换对方 1 张；2 = 换对方 2 张）与已选目标 */
  trade: {
    giveIds: number[];
    mode: 1 | 2;
    targetPlayerId: string | null;
    /** 同花色给牌：等待玩家选择换 1 张还是 2 张（同花色也算同颜色） */
    chooseTake: boolean;
  } | null;
  /** 障目再入：待门控的换牌目标 */
  gate: { skillId: 'sao-sao'; targetId: string } | null;
}

/** 骚骚盲抽询问（障目门控通过后执行）：从目标手牌盲抽拿走 */
function saoSaoAskBlind(ctx: HookContext, st: CsState, targetPlayerId: string): HookResult {
  st.trade = { ...st.trade!, targetPlayerId };
  const need = st.trade.mode === 1 ? 1 : 2;
  return {
    ok: true,
    ask: {
      kind: 'pickCards',
      prompt: `从目标手中盲抽 ${need} 张拿走（只看牌背）`,
      cards: [...ctx.game.handOf(targetPlayerId)],
      min: need,
      max: need,
      hidden: true,
    },
  };
}

const csChampion: RoleDef = {
  id: 'cs-champion',
  seatOrder: 6,
  name: '第六席 企鹅',
  skills: [
    {
      id: 'sao-sao',
      name: '骚骚',
      description:
        '接牌时给同花色 2 张换对方 1 张（同花色也算同颜色，可自选换 1 张或 2 张），或仅同颜色 2 张换 2 张（换牌取代出牌、视为过牌，换完轮下家）。',
    },
  ],
  skillActions: [{ skillId: 'sao-sao', when: 'following', label: '骚骚' }],
  setup(): CsState {
    return { trade: null, gate: null };
  },
  hooks: {
    onSkillAction(ctx, req) {
      if (req.skillId !== 'sao-sao') return;
      const st = ctx.state as CsState;
      const a = ctx.answer;
      // 障目再入（骚骚猜牌/摸牌答案）：门控通过后进入盲抽
      if (st.gate?.skillId === 'sao-sao') {
        const t = st.gate.targetId;
        const g = ctx.game.zhangMuCheck(ctx.self.id, t, 'sao-sao', () => {
          st.gate = null;
          return saoSaoAskBlind(ctx, st, t);
        });
        if (g) {
          if (st.gate && !('ask' in g)) st.gate = null; // 障目猜错/已封锁：清残留门控（防下次钩子误入再问）
          return g;
        }
        st.gate = null;
        return; // 防御
      }
      /** 选目标（候选：手牌数 ≥ 需拿张数）；无候选则作废 */
      const askTarget = (): HookResult | void => {
        const need = st.trade!.mode === 1 ? 1 : 2;
        const others = ctx.game
          .players()
          .filter((p) => p.id !== ctx.self.id && p.handCount >= need)
          .map((p) => p.id);
        if (others.length === 0) {
          ctx.game.announce('cs-champion', 'sao-sao', '【骚骚】没有手牌足够的目标');
          st.trade = null;
          return;
        }
        return {
          ok: true,
          ask: {
            kind: 'pickTarget',
            prompt: `选择换牌目标（拿对方 ${need} 张）`,
            targetCandidates: others,
          },
        };
      };
      // 阶段 1：确认发动
      if (!a) {
        return {
          ok: true,
          ask: {
            kind: 'confirm',
            prompt:
              '是否发动【骚骚】？同花色 2 张换对方 1 张（也可选换 2 张），仅同颜色 2 张换 2 张（换牌取代本次出牌，视为过牌）',
          },
        };
      }
      // 任何阶段弃权（含超时自动弃权）：技能作废、清中间态
      if (a.choice === 'decline') {
        st.trade = null;
        return;
      }
      if (a.choice === 'yes') {
        return {
          ok: true,
          ask: {
            kind: 'pickCards',
            prompt: '选出 2 张手牌交给对方（同花色可选换 1 或 2 张，仅同颜色换 2 张）',
            cards: [...ctx.self.hand],
            min: 2,
            max: 2,
          },
        };
      }
      // 阶段 4：目标与盲抽均已定 → 执行交换（目标存于 st.trade，盲抽答案只有 cardIds）
      if (a.cardIds && st.trade?.targetPlayerId) {
        const { giveIds, mode, targetPlayerId } = st.trade;
        st.trade = null;
        const give = ctx.self.hand.filter((c) => giveIds.includes(c.id));
        const take = ctx.game.handOf(targetPlayerId).filter((c) => a.cardIds!.includes(c.id));
        const need = mode === 1 ? 1 : 2;
        if (give.length !== 2 || take.length !== need) {
          // 防作弊/状态漂移：校验失败则本次技能静默作废
          ctx.game.announce('cs-champion', 'sao-sao', '【骚骚】换牌无效，技能作废');
          return;
        }
        const targetName = ctx.game.players().find((p) => p.id === targetPlayerId)?.name ?? '目标';
        ctx.game.giveFrom(ctx.self.id, give.map((c) => c.id));
        ctx.game.giveTo(targetPlayerId, give);
        ctx.game.giveFrom(targetPlayerId, take.map((c) => c.id));
        ctx.game.giveTo(ctx.self.id, take);
        ctx.game.announce('cs-champion', 'sao-sao', `【骚骚】与 ${targetName} 交换手牌`);
        return { ok: true, modify: { endTurn: true } };
      }
      // 阶段 2：自己给出的两张牌 → 定条件（同花色 / 仅同颜色 / 都不同）
      if (a.cardIds && !st.trade) {
        const give = ctx.self.hand.filter((c) => a.cardIds!.includes(c.id));
        if (give.length !== 2) return { ok: false, reason: '请选择 2 张手牌' };
        const suits = new Set(give.map((c) => c.suit));
        const colors = new Set(give.map((c) => cardColor(c)));
        if (suits.size !== 1 && colors.size !== 1) {
          ctx.game.announce('cs-champion', 'sao-sao', '【骚骚】两张牌花色、颜色都不同，无法发动');
          return;
        }
        const sameSuit = suits.size === 1;
        st.trade = {
          giveIds: give.map((c) => c.id),
          mode: sameSuit ? 1 : 2,
          targetPlayerId: null,
          chooseTake: sameSuit,
        };
        if (!sameSuit) return askTarget();
        // 同花色也算同颜色：自由选择换 1 张还是 2 张
        return {
          ok: true,
          ask: {
            kind: 'choice',
            prompt: '同花色也算同颜色：换对方 1 张还是 2 张？',
            options: ['换 1 张', '换 2 张'],
          },
        };
      }
      // 阶段 2.5：同花色 → 玩家选择换 1 张还是 2 张
      if (st.trade?.chooseTake && a.choice) {
        if (a.choice !== '换 1 张' && a.choice !== '换 2 张') {
          ctx.game.announce('cs-champion', 'sao-sao', '【骚骚】选择无效，技能作废');
          st.trade = null;
          return;
        }
        st.trade = { ...st.trade, mode: a.choice === '换 2 张' ? 2 : 1, chooseTake: false };
        return askTarget();
      }
      // 阶段 3：目标已定 → 从目标手牌盲抽（只看牌背，凭运气抽，增加游戏体验）
      if (a.targetPlayerId && !a.cardIds && st.trade && !st.trade.targetPlayerId) {
        if (ctx.game.bpProtected(a.targetPlayerId)) return; // 血压（硝烟）全挡：技能不能对其生效
        // 障目门控（指向性：换牌目标为辛歼时先猜手牌数）
        st.gate = { skillId: 'sao-sao', targetId: a.targetPlayerId };
        const g = ctx.game.zhangMuCheck(ctx.self.id, a.targetPlayerId, 'sao-sao', () => {
          st.gate = null;
          return saoSaoAskBlind(ctx, st, a.targetPlayerId!);
        });
        if (g) {
          if (st.gate && !('ask' in g)) st.gate = null; // 障目已封锁（猜错后对他人发动）：清残留门控
          return g;
        }
        st.gate = null;
        return saoSaoAskBlind(ctx, st, a.targetPlayerId); // 直接放行
      }
      // 未匹配任何阶段（异常载荷）：技能作废、清中间态
      st.trade = null;
      ctx.game.announce('cs-champion', 'sao-sao', '【骚骚】操作无效，技能作废');
    },
  },
};

export default csChampion;
