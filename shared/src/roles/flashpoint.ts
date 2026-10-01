// 角色：第四席 阿毛 —— 技能【茄汤】。
// 轮到你出牌时可发动：展示全部手牌，若红色牌 ≥ 一半，则剩余黑色手牌（含小王）立即当作炸弹打出，
// 炸弹点数 = 其中最大的牌；1/2 张黑牌为一元炸/二元炸，可被任何三元及以上的炸弹压。
// 红色不足一半或无黑牌则仅展示、不发动。
import { cardColor, isJoker, rankLabel } from '../cards';
import { canBeat, type Combo } from '../engine/combos';
import type { RoleDef } from './types';

const flashpoint: RoleDef = {
  id: 'flashpoint',
  seatOrder: 4,
  name: '第四席 阿毛',
  skills: [
    { id: 'qie-tang', name: '茄汤', description: '出牌时展示全部手牌，红色 ≥ 一半则剩余黑牌当作炸弹打出（1/2 张为一元炸/二元炸）。' },
  ],
  skillActions: [{ skillId: 'qie-tang', when: 'myTurn', label: '茄汤' }],
  hooks: {
    onSkillAction(ctx, req) {
      if (req.skillId !== 'qie-tang') return;
      const hand = [...ctx.self.hand];
      if (hand.length === 0) return;
      ctx.game.revealCards(hand, '茄汤');
      const reds = hand.filter((c) => cardColor(c) === 'red').length;
      if (reds * 2 < hand.length) {
        ctx.game.announce('flashpoint', 'qie-tang', '【茄汤】红色不足一半，未能成汤');
        return;
      }
      const blacks = hand.filter((c) => cardColor(c) === 'black');
      const real = blacks.filter((c) => !isJoker(c));
      const cfg = ctx.game.cfg;
      if (blacks.length < 1 || real.length < 1) {
        ctx.game.announce('flashpoint', 'qie-tang', '【茄汤】没有黑牌，未能成炸');
        return;
      }
      const rank = Math.max(...blacks.map((c) => c.rank)) as Combo['rank'];
      const label =
        blacks.length === 1
          ? `一元炸(${rankLabel(rank)})`
          : blacks.length === 2
            ? `二元炸(${rankLabel(rank)})`
            : `茄汤炸弹(${rankLabel(rank)})`;
      const combo: Combo = {
        type: 'bomb',
        cards: [...blacks],
        rank,
        length: blacks.length,
        resolved: blacks.map((c) => ({ cardId: c.id, rank: (isJoker(c) ? rank : c.rank) as Combo['rank'] })),
        label,
      };
      // 接牌时须真能压过桌面（基础规则技能优先，但插队类特殊组合仍需校验）
      if (ctx.game.table() && !canBeat(combo, ctx.game.table(), cfg)) {
        ctx.game.announce('flashpoint', 'qie-tang', '【茄汤】成炸但压不过桌面，未能打出');
        return;
      }
      ctx.game.announce('flashpoint', 'qie-tang', `【茄汤】黑牌成炸！点数 ${rankLabel(rank)}`);
      ctx.game.playForcedCombo(combo);
    },
  },
};

export default flashpoint;
