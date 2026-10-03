// 角色：修勾 —— 技能【答疑】+【狂吠】。
// 【答疑】任何人（含自己）打出 ≥2 张的牌型（对/顺子/连对/炸）时，可为其答疑：
// 不改变牌型，把桌面这手牌的判定点数改为修勾任选的 3~A（顺子/连对改的是起点，
// 按当前牌序约定：正序 = 最低点、倒序 = 最高点——倒序镜像语义待用户复核）。
// 每回合（轮）限一次，弃权不消耗；只影响判定，实体牌不变（巨石等按实体牌判定）。
// 【狂吠】出牌后可以立刻按正常管牌规则压自己打出的牌，可连压到放弃/压不了。
import type { RoleDef } from './types';

interface DoggieState {
  /** 本回合是否已用过答疑（每回合限一次，弃权不消耗） */
  answeredThisRound: boolean;
}

/** 可选点数 3~A（choice 选项文本 → 点数编码） */
const RANK_CHOICES = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
const RANK_OF: Record<string, number> = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  J: 11, Q: 12, K: 13, A: 14,
};

const doggie: RoleDef = {
  id: 'doggie',
  name: '修勾',
  canSelfFollow: true,
  skills: [
    { id: 'da-yi', name: '答疑', description: '有人打出 ≥2 张的牌型时，你可以为其答疑：不改变牌型，把判定点数改为你选的 3~A（顺子/连对改起点），每回合限一次。' },
    { id: 'kuang-fei', name: '狂吠', description: '你出牌后可以立刻按正常管牌规则压自己打出的牌，可连续压到放弃或压不了。' },
  ],
  setup(): DoggieState {
    return { answeredThisRound: false };
  },
  hooks: {
    onPlayInterrupt(ctx, played) {
      if (played.type === 'single') return; // 只对 ≥2 张的牌型（对/顺子/连对/炸）
      const st = ctx.state as DoggieState;
      const a = ctx.answer;
      if (!a) {
        if (st.answeredThisRound) return;
        return {
          ok: true,
          ask: {
            kind: 'choice',
            prompt: `【答疑】为这手牌（${played.label}）答疑：不改变牌型，把判定点数改为你选的值（顺子/连对改起点；每回合限一次，弃权不消耗）`,
            options: [...RANK_CHOICES, '放弃'],
          },
        };
      }
      if (st.answeredThisRound) return; // 防御：同轮重复回答
      const choice = a.choice ?? '';
      if (choice === 'decline' || choice === '放弃' || !(choice in RANK_OF)) return; // 弃权不消耗次数
      st.answeredThisRound = true;
      ctx.game.retagTable(RANK_OF[choice]!);
      ctx.game.announce('doggie', 'da-yi', `【答疑】桌面牌改按点数 ${choice} 判定`);
      return { ok: true };
    },
    onRoundEnd(ctx) {
      (ctx.state as DoggieState).answeredThisRound = false; // 每回合（轮）限一次
    },
  },
};

export default doggie;
