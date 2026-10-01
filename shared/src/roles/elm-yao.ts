// 角色：第二席 圣母 —— 技能【斜视】。
// 你可以用与上家牌型相同（同类型、同张数）、点数相差 0 或 1 的牌型响应（全部牌型，含炸弹）。
import type { RoleDef } from './types';

const elmYao: RoleDef = {
  id: 'elm-yao',
  seatOrder: 2,
  name: '第二席 圣母',
  skills: [
    { id: 'xie-shi', name: '斜视', description: '你可以用点数相差 0 或 1 的同类型同张数牌型响应任何牌（含炸弹）。' },
  ],
  hooks: {
    beforePlay(ctx, proposed) {
      if (ctx.game.turnPlayerId() !== ctx.self.id) return;
      const { combo, table } = proposed;
      if (!table || combo.type !== table.type || combo.length !== table.length) return;
      if (Math.abs(combo.rank - table.rank) > 1) return;
      ctx.game.announce('elm-yao', 'xie-shi', '【斜视】差 0/1 也能接！');
      return { ok: true, allowAnyway: true };
    },
  },
};

export default elmYao;
