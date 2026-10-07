// 角色：首席 杰杰一世 —— 双技能【蛋神】+【仁德】。
// 蛋神：你的 Q 可以压任何单牌（但 2 仍需炸弹压）。
// 仁德：单 2 可以被 3 响应；你最后一张手牌不可为单 Q / 对 Q（含 Q 的顺子等照常可打出）。
import type { RoleDef } from './types';

const skywalker: RoleDef = {
  id: 'skywalker',
  seatOrder: 1,
  name: '首席 杰杰一世',
  skills: [
    { id: 'dan-shen', name: '蛋神', description: '你的 Q 可以压任何单牌（2 除外）。' },
    { id: 'ren-de', name: '仁德', description: '你的单 2 可以被 3 响应；你最后一张手牌不可为单 Q / 对 Q。', locked: true },
  ],
  hooks: {
    beforePlay(ctx, proposed) {
      const { combo, table } = proposed;
      const mine = ctx.game.turnPlayerId() === ctx.self.id;
      // 仁德：单 3 可以压单 2（任何人的单 2）
      if (
        !mine &&
        table &&
        table.type === 'single' &&
        table.rank === 15 &&
        combo.type === 'single' &&
        combo.rank === 3
      ) {
        ctx.game.announce('skywalker', 'ren-de', '【仁德】3 可响应 2！');
        return { ok: true, allowAnyway: true };
      }
      if (!mine) return;
      // 仁德：最后一张手牌不可为 Q——只针对单 Q / 对 Q 收尾（2026-10-07 用户澄清：
      // 含 Q 的顺子/连对/炸弹照常可打出，不因含 Q 被否决）
      if (
        combo.cards.length === ctx.self.hand.length &&
        (combo.type === 'single' || combo.type === 'pair') &&
        combo.rank === 12
      ) {
        return { ok: false, reason: '【仁德】最后一张手牌不可为 Q' };
      }
      // 蛋神：自己的 Q 压任何单牌（2 除外，2 只有炸弹能压）
      if (table && table.type === 'single' && table.rank !== 15 && combo.type === 'single' && combo.rank === 12) {
        ctx.game.announce('skywalker', 'dan-shen', '【蛋神】Q 压一切单牌！');
        return { ok: true, allowAnyway: true };
      }
    },
  },
};

export default skywalker;
