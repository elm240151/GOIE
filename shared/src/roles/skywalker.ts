// 角色：首席 杰杰一世 —— 双技能【蛋神】+【仁德】。
// 蛋神：你的单 Q 压一切单牌、对 Q 压一切对子（2026-10-07 用户澄清：原文「Q 压任何一张单牌」无 2 除外，
// 倒序照常压 3；对 Q 为本次新增，压完照常被压——正序被 K/2、倒序被 J）。
// 仁德：单 2 可以被 3 响应、对 2 可以被对 3 响应（2026-10-07 用户类推确认）；
// 你最后一张手牌不可为单 Q / 对 Q（含 Q 的顺子等照常可打出）。
import type { RoleDef } from './types';

const skywalker: RoleDef = {
  id: 'skywalker',
  seatOrder: 1,
  name: '首席 杰杰一世',
  skills: [
    { id: 'dan-shen', name: '蛋神', description: '你的单 Q 可以压任何单牌、对 Q 可以压任何对子（压完后照常被压）。' },
    { id: 'ren-de', name: '仁德', description: '你的单 2 可以被 3 响应、对 2 可以被对 3 响应；你最后一张手牌不可为单 Q / 对 Q。', locked: true },
  ],
  hooks: {
    beforePlay(ctx, proposed) {
      const { combo, table } = proposed;
      const mine = ctx.game.turnPlayerId() === ctx.self.id;
      // 仁德：单 3 可以压单 2、对 3 可以压对 2（任何人的 2；2026-10-07 用户类推确认）
      if (
        !mine &&
        table &&
        table.type === combo.type &&
        (combo.type === 'single' || combo.type === 'pair') &&
        table.rank === 15 &&
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
      // 蛋神：自己的单 Q 压一切单牌、对 Q 压一切对子（正倒序一致，压完后照常被压——2026-10-07 用户澄清）
      if (table && combo.type === table.type && (combo.type === 'single' || combo.type === 'pair') && combo.rank === 12) {
        ctx.game.announce('skywalker', 'dan-shen', '【蛋神】Q 压一切！');
        return { ok: true, allowAnyway: true };
      }
    },
  },
};

export default skywalker;
