// 角色：轴承 —— 技能【端庄】【窃笑】。
// 【端庄】响应时发动（canFlipResponse 标志，机制在引擎 + 客户端）：轮到你响应时，可翻面一张
//   上次打出的牌并继续接牌——桌面只有一张（情况一）则翻掉整手、接上一手的牌（正常管牌规则）；
//   桌面多张（情况二）则翻掉其中一张，剩余仍是合法牌型 → 正常管牌规则接；剩余非法 → 打后继
//   （每张剩余牌按原牌型中所当点数 +1，倒序同样 +1；王按所当点数、响应可用王补缺）或炸弹，
//   后继接出的桌面（翻面接）只有炸弹能压。翻面牌留桌旁展示为牌背；翻面只对轴承自己的出牌回合生效。
// 【窃笑】主动技：轮到自己时、每轮一次，可私密查看一名玩家手牌；被查看者收到提示（其余人不知）。
import type { RoleDef } from './types';

interface ButtonState {
  /** 窃笑本轮是否已用（轮末重置） */
  peekedThisRound: boolean;
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
        '轮到你响应时，可翻面一张上次打出的牌并按规则继续接牌；剩余不是合法牌型时，打后继（每张点数 +1，王可补缺）或炸弹，后继接出的桌面只有炸弹能压。翻面只对自己的出牌回合生效。',
    },
    {
      id: 'qie-xiao',
      name: '窃笑',
      description: '轮到自己时（每轮一次）可私密查看一名玩家的手牌；对方会收到提示。',
    },
  ],
  skillActions: [{ skillId: 'qie-xiao', when: 'myTurn', label: '窃笑' }],
  setup(): ButtonState {
    return { peekedThisRound: false };
  },
  hooks: {
    onRoundEnd(ctx) {
      (ctx.state as ButtonState).peekedThisRound = false;
    },
    onSkillAction(ctx, req) {
      if (req.skillId !== 'qie-xiao') return;
      const st = ctx.state as ButtonState;
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
      st.peekedThisRound = true;
      ctx.game.peekHand(ctx.answer.targetPlayerId);
    },
  },
};

export default button;
