// 角色：海棠 —— 技能【洄游】【隐匿】。
// 【洄游】锁定技：每次出牌（含插队，按物理出牌者计）切换一次牌序正↔倒；每轮结束恢复正序。
//   倒序 = 整条牌序反转：恰好小一级可压；3 最大压一切（3 压不了 3、对 3 只有炸压）；2 最小谁也
//   压不了（倒序用 A 响应 2）；顺子/连对为倒序连续（起点 = 最高点数）；炸弹张数优先不变、同张数
//   比点反转（3 炸最强）。倒序下留 2 不禁止，禁止收尾的变成单 3/对 3。
// 【隐匿】轮末结算（上一回合的结算阶段，早于整备类技能）：本回合一次也没出过牌（含插队）→ 询问
//   是否弃一张手牌并摸一张（重铸）；弃权/超时则放弃。
import type { HookContext, HookResult, RoleDef } from './types';

interface FishyState {
  /** 隐匿询问阶段：null = 确认；'pick' = 选牌重铸 */
  stage: 'pick' | null;
}

/** 隐匿询问流：确认 → 选牌 → 弃一摸一；阶段由 st.stage 分派 */
function yinNiFlow(ctx: HookContext, st: FishyState): HookResult | void {
  const a = ctx.answer;
  if (st.stage === 'pick') {
    // 选牌阶段（pickCards 超时/弃权自动放弃，答案可能没有牌）
    st.stage = null;
    const cardId = a?.cardIds?.[0];
    const card = cardId ? ctx.game.handOf(ctx.self.id).find((c) => c.id === cardId) : undefined;
    if (card) {
      ctx.game.discardFromHand(ctx.self.id, [card.id]);
      ctx.game.draw(ctx.self.id, 1);
      ctx.game.announce('fishy', 'yin-ni', '【隐匿】重铸了一张手牌');
    }
    return;
  }
  if (!a) {
    return { ok: true, ask: { kind: 'confirm', prompt: '【隐匿】本回合你尚未出牌，是否弃一张手牌并摸一张？' } };
  }
  if (a.choice !== 'yes') return; // 弃权
  st.stage = 'pick';
  return {
    ok: true,
    ask: {
      kind: 'pickCards',
      prompt: '【隐匿】选择要弃置的一张手牌（弃权则放弃重铸）',
      cards: [...ctx.game.handOf(ctx.self.id)],
      min: 1,
      max: 1,
    },
  };
}

const fishy: RoleDef = {
  id: 'fishy',
  name: '海棠',
  // 出牌即切换牌序（引擎按物理出牌者计数，每轮清零）
  flipsOrderOnPlay: true,
  // 轮末结算先于整备类技能（抽你 900）：重铸摸的牌在整备阶段已可用
  priority: 1000,
  skills: [
    {
      id: 'hui-you',
      name: '洄游',
      locked: true,
      description:
        '每次出牌切换一次牌序（正↔倒）。倒序：恰好小一级可压、3 最大、2 最小、顺子/连对倒序连续、炸弹同张数比点反转。',
    },
    {
      id: 'yin-ni',
      name: '隐匿',
      description: '轮末结算：本回合一次也没出过牌，可弃一张手牌并摸一张。',
    },
  ],
  setup(): FishyState {
    return { stage: null };
  },
  hooks: {
    onRoundEnd(ctx) {
      const st = ctx.state as FishyState;
      // 回答分派必须先于守卫（多阶段重跑：确认/选牌阶段带答案回来）
      if (ctx.answer || st.stage === 'pick') return yinNiFlow(ctx, st);
      if (ctx.game.eliminated(ctx.self.id)) return;
      // 本回合出过牌（含插队）→ 不发动
      if (ctx.game.flipCountThisRound() !== 0) return;
      if (ctx.game.handOf(ctx.self.id).length === 0) return; // 防御：空手必已获胜，不会走到这里
      return yinNiFlow(ctx, st);
    },
  },
};

export default fishy;
