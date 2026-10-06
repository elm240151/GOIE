// 角色：阿色 —— 技能【抽你】【再问】。
// 【抽你】整备阶段（拥有牌权、摸牌前）发动，每局限 X+2 次（X = 人数）：指定一人，
//   新起的一轮里只有其能响应你的牌（被指定者淘汰/掉线限制继续有效）。
//   首回合没有摸牌阶段但仍有整备阶段：开局先手的阿色在起牌前同样可以发动。
// 【再问】每轮限一次（确认弃权即消耗）：有人压你的牌（插队也算）时，压牌者须再打出一张
//   与其那手牌中任意一张同点数或同花色的牌（王按实际代表点数与包含花色），明置桌旁；
//   打不出/弃权/超时 → 那手牌视作你打出（归属改写：轮转从你下家继续，判定对你生效）。
//   压牌者已打出最后一张牌时不再问（谁打完谁赢，引擎收尾直接判其获胜）。
import { isJoker, jokerSuits, type Card } from '../cards';
import type { Combo } from '../engine/combos';
import type { HookContext, HookResult, RoleDef } from './types';

export { jokerSuits }; // 兼容旧导入（王的包含花色已上收至 cards.ts，2026-10-03）

interface CaptainState {
  /** 抽你剩余次数（每局 X+2 次） */
  uses: number;
  /** 抽你指定目标（新起的一轮有效；null = 未指定/已到期） */
  designated: string | null;
  /** 抽你询问阶段：null = 确认；'pick' = 选目标 */
  stage: 'pick' | null;
  /** 再问：本轮是否已发动（确认弃权即消耗） */
  zwUsed: boolean;
  /** 再问：阶段二询问对象（压牌者） */
  zwBeater: string | null;
  /** 开局整备是否已处理（首回合无摸牌但仍有整备阶段；轮末 onRoundEnd 也会置位） */
  startPhaseDone: boolean;
}

/** 抽你询问流（开局整备与轮末整备共用）：确认 → 选目标；阶段由 st.stage 分派 */
function chouNiFlow(ctx: HookContext, st: CaptainState): HookResult | void {
  const a = ctx.answer;
  if (st.stage === 'pick') {
    // 选目标阶段（pickTarget 超时自动弃权，答案可能没有目标）
    st.stage = null;
    const t = a?.targetPlayerId;
    if (t && t !== ctx.self.id && !ctx.game.eliminated(t)) {
      st.uses--;
      st.designated = t;
      const name = ctx.game.players().find((p) => p.id === t)?.name ?? t;
      ctx.game.announce('captain', 'chou-ni', `指定 ${name}：本回合只有 TA 能响应`);
    } else {
      st.designated = null;
    }
    return;
  }
  if (st.uses <= 0) {
    st.designated = null;
    return;
  }
  if (!a) {
    return { ok: true, ask: { kind: 'confirm', prompt: `是否发动【抽你】？（本局还可发动 ${st.uses} 次）` } };
  }
  if (a.choice === 'decline') {
    st.designated = null;
    return;
  }
  st.stage = 'pick';
  const others = ctx.game
    .players()
    .filter((p) => p.id !== ctx.self.id && !ctx.game.eliminated(p.id))
    .map((p) => p.id);
  return {
    ok: true,
    ask: { kind: 'pickTarget', prompt: '【抽你】指定一人：本回合只能由其响应你的牌', targetCandidates: others },
  };
}

/** 一张牌是否与某手牌（Combo）中任意一张「同点数或同花色」：
 *  点数按每张牌实际代表的点数（combo.resolved，王按所补的位置）；花色按王的包含花色。 */
export function matchesRankOrSuit(card: Card, combo: Combo): boolean {
  const mySuits = isJoker(card) ? jokerSuits(card) : [card.suit];
  for (const c of combo.cards) {
    const repRank = combo.resolved.find((r) => r.cardId === c.id)?.rank ?? c.rank;
    if (card.rank === repRank) return true;
    const suits = isJoker(c) ? jokerSuits(c) : [c.suit];
    if (mySuits.some((s) => suits.includes(s))) return true;
  }
  return false;
}

const captain: RoleDef = {
  id: 'captain',
  name: '阿色',
  // 高优先级：再问的归属改写必须先于其他角色对同一手牌的判定钩子（如地坛≥3张判定）
  priority: 900,
  skills: [
    { id: 'chou-ni', name: '抽你', description: '每局限 X+2 次（X = 人数）：拥有牌权时指定一人，下一轮只有其能响应你的牌。' },
    { id: 'zai-wen', name: '再问', description: '每轮限一次：有人压你的牌时，压牌者须再打出一张同点数或同花色的牌，否则那手牌归你。' },
  ],
  setup(ctx): CaptainState {
    return {
      uses: ctx.game.players().length + 2,
      designated: null,
      stage: null,
      zwUsed: false,
      zwBeater: null,
      startPhaseDone: false,
    };
  },
  hooks: {
    afterPlay(ctx) {
      const st = ctx.state as CaptainState;
      const a = ctx.answer;
      // 自己刚出牌（含归属改写后）：处于抽你轮则对当前桌面设响应限制
      // （被指定者淘汰/掉线限制继续有效：无人能响应，只能全过）
      if (ctx.game.roundLastPlayerId() === ctx.self.id && st.designated) {
        ctx.game.setTableResponderRestrict(st.designated);
      }
      // 再问：只关心有人压自己的牌（插队也算——插队同样走 afterPlay 流水线）
      if (ctx.game.respondedTo() !== ctx.self.id) return;
      if (st.zwUsed) return;
      // 压牌者已打出最后一张牌：谁打完谁赢，不再问（引擎收尾直接判其获胜）
      if (ctx.game.handOf(ctx.game.roundLastPlayerId()!).length === 0) return;
      if (st.zwBeater) {
        // 阶段二：压牌者作答（弃权/超时/不合规 → 归属改写）
        const beater = st.zwBeater;
        st.zwBeater = null;
        st.zwUsed = true;
        const table = ctx.game.table()!;
        const card = a?.cardIds ? ctx.game.handOf(beater).find((c) => c.id === a.cardIds![0]) : undefined;
        if (card && matchesRankOrSuit(card, table)) {
          ctx.game.playSideCard(beater, card.id);
          const name = ctx.game.players().find((p) => p.id === beater)?.name ?? beater;
          ctx.game.announce('captain', 'zai-wen', `${name} 补打一张`);
          return;
        }
        if (ctx.game.bpProtected(beater)) {
          // 血压（硝烟）全挡：归属改写是技能对其生效（改变其出牌的归属/判定基准）→ 不归属
          ctx.game.announce('captain', 'zai-wen', '压牌未补打；受血压保护，不改变归属');
          return;
        }
        ctx.game.attributeTable(ctx.self.id);
        // 抽你联动：归属后的手牌仍是阿色的牌，响应限制照旧（被指定者淘汰/掉线限制继续有效）
        if (st.designated) ctx.game.setTableResponderRestrict(st.designated);
        ctx.game.announce('captain', 'zai-wen', '压牌未补打，归阿色');
        return;
      }
      if (!a) {
        return { ok: true, ask: { kind: 'confirm', prompt: '有人压了你的牌，是否发动【再问】？（每轮限一次）' } };
      }
      if (a.choice === 'decline') {
        st.zwUsed = true; // 弃权即消耗
        return;
      }
      // 阶段一确认：问压牌者补打一张（只给满足条件的牌）；
      // 留 X 禁止收尾：压牌者只剩一张且是特殊点数（正序 2/倒序 3）→ 不可补打（防空手僵尸态）
      const beater = ctx.game.roundLastPlayerId()!;
      st.zwBeater = beater;
      const hand = ctx.game.handOf(beater);
      const special = ctx.game.orderReversed() ? 3 : 15;
      const valid = hand.filter(
        (c) => matchesRankOrSuit(c, ctx.game.table()!) && !(hand.length === 1 && c.rank === special)
      );
      return {
        ok: true,
        ask: {
          kind: 'pickCards',
          prompt: '【再问】请打出一张与压牌同点数或同花色的牌（弃权/超时则压牌归阿色）',
          cards: valid,
          min: 1,
          max: 1,
          askPlayerId: beater,
        },
      };
    },
    onTurnStart(ctx) {
      const st = ctx.state as CaptainState;
      if (ctx.game.eliminated(ctx.self.id)) return;
      if (st.stage === 'pick') {
        // 开局抽你的选目标阶段（多阶段重跑）
        return chouNiFlow(ctx, st);
      }
      if (ctx.answer) {
        // 确认阶段回答（多阶段重跑；startPhaseDone 已在首次运行时置位）
        return chouNiFlow(ctx, st);
      }
      if (st.startPhaseDone) return;
      // 首回合整备：开局起牌没有轮末摸牌，但摸牌前仍有整备阶段 → 先手阿色可发动抽你
      if (ctx.game.turnPlayerId() !== ctx.self.id || ctx.game.roundLeaderId() !== ctx.self.id) return;
      st.startPhaseDone = true;
      return chouNiFlow(ctx, st);
    },
    onRoundEnd(ctx, lastPlayerId) {
      const st = ctx.state as CaptainState;
      if (ctx.game.eliminated(ctx.self.id)) {
        st.designated = null;
        st.zwUsed = false;
        return;
      }
      // 首回合已结束：开局整备不再适用（此后抽你只在轮末整备发动）
      st.startPhaseDone = true;
      if (st.stage === 'pick') {
        // 轮末抽你的选目标阶段（多阶段重跑）
        chouNiFlow(ctx, st);
        return; // 正常摸牌
      }
      // 新一轮：再问重置
      st.zwUsed = false;
      if (lastPlayerId !== ctx.self.id) {
        // 别人获得牌权：抽你指定到期
        st.designated = null;
        return;
      }
      // 整备阶段（拥有牌权、摸牌前）：发动抽你
      return chouNiFlow(ctx, st);
    },
  },
};

export default captain;
