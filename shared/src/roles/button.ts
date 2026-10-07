// 角色：轴承 —— 技能【端庄】【窃笑】。
// 【端庄】响应时发动（canFlipResponse 标志，机制在引擎 + 客户端）：轮到你响应时，可翻面一张
//   上次打出的牌并继续接牌——桌面只有一张（情况一）则翻掉整手、接上一手的牌（正常管牌规则）；
//   桌面多张（情况二）则翻掉其中一张，剩余仍是合法牌型 → 正常管牌规则接；剩余非法 → 打后继
//   （每张剩余牌按原牌型中所当点数 ±1：正序 +1、倒序 −1——倒序镜像，用户 2026-10-04 最终确认；
//   王按所当点数、响应可用王补缺）或炸弹，后继接出的桌面（翻面接）只有炸弹能压。
//   翻面牌留桌旁展示为牌背；翻面只对轴承自己的出牌回合生效。
// 【窃笑】主动技：轮到自己时、每轮一次，可私密查看一名玩家手牌；被查看者收到提示（其余人不知）。
import type { RoleDef } from './types';

interface ButtonState {
  /** 窃笑本轮是否已用（轮末重置） */
  peekedThisRound: boolean;
  /** 障目再入：待门控的查看目标 */
  gate: { skillId: 'qie-xiao'; targetId: string } | null;
}

const button: RoleDef = {
  id: 'button',
  name: '轴承',
  canFlipResponse: true,
  skills: [
    {
      id: 'duan-zhuang',
      name: '端庄',
      description:
        '轮到你响应时，可翻面一张上次打出的牌并按规则继续接牌；剩余不是合法牌型时，打后继（每张点数 ±1：正序 +1、倒序 −1，王可补缺）或炸弹，后继接出的桌面只有炸弹能压。翻面只对自己的出牌回合生效。',
    },
    {
      id: 'qie-xiao',
      name: '窃笑',
      description: '轮到自己时（每轮一次）可私密查看一名玩家的手牌；对方会收到提示。',
    },
  ],
  skillActions: [
    {
      skillId: 'qie-xiao',
      when: 'myTurn',
      label: '窃笑',
      // 每轮一次（2026-10-07 用户反馈：按钮直接标次数）：已用则灰显
      remaining: (state) => ((state as ButtonState).peekedThisRound ? 0 : null),
    },
  ],
  setup(): ButtonState {
    return { peekedThisRound: false, gate: null };
  },
  hooks: {
    onRoundEnd(ctx) {
      (ctx.state as ButtonState).peekedThisRound = false;
    },
    onSkillAction(ctx, req) {
      if (req.skillId !== 'qie-xiao') return;
      const st = ctx.state as ButtonState;
      // 障目再入（窃笑猜牌/摸牌答案）：门控通过后照常查看
      if (st.gate?.skillId === 'qie-xiao') {
        const { targetId } = st.gate;
        const g = ctx.game.zhangMuCheck(ctx.self.id, targetId, 'qie-xiao', () => {
          st.gate = null;
          st.peekedThisRound = true;
          ctx.game.peekHand(targetId);
        });
        if (g) {
          if (st.gate && !('ask' in g)) st.gate = null; // 障目猜错/已封锁：清残留门控（防下次钩子误入再问）
          return g;
        }
        st.gate = null;
        return; // 防御
      }
      if (st.peekedThisRound) return { ok: false, reason: '【窃笑】本轮已经使用过了' };
      if (!ctx.answer) {
        const others = ctx.game
          .players()
          .filter((p) => p.id !== ctx.self.id)
          .map((p) => p.id);
        if (others.length === 0) return { ok: false, reason: '没有可查看的对象' };
        return {
          ok: true,
          ask: {
            kind: 'pickTarget',
            prompt: '【窃笑】要查看谁的手牌？（对方会收到提示，其余人不会知道）',
            targetCandidates: others,
          },
        };
      }
      if (ctx.answer.choice === 'decline' || !ctx.answer.targetPlayerId) return; // 弃权不消耗
      if (ctx.game.bpProtected(ctx.answer.targetPlayerId)) return; // 血压（硝烟）全挡：技能不能对其生效
      // 障目门控（指向性：查看辛歼时先猜手牌数；猜错不消耗次数）
      st.gate = { skillId: 'qie-xiao', targetId: ctx.answer.targetPlayerId };
      const g = ctx.game.zhangMuCheck(ctx.self.id, ctx.answer.targetPlayerId, 'qie-xiao', () => {
        st.gate = null;
        st.peekedThisRound = true;
        ctx.game.peekHand(ctx.answer!.targetPlayerId!);
      });
      if (g) {
        if (st.gate && !('ask' in g)) st.gate = null; // 障目已封锁（猜错后对他人发动）：清残留门控
        return g;
      }
      st.gate = null;
      st.peekedThisRound = true;
      ctx.game.peekHand(ctx.answer.targetPlayerId); // 直接放行
    },
  },
};

export default button;
