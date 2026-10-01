// 角色：第七席 圣帕特里克 —— 技能【无名】。
// 响应他人的牌时，若你的响应牌中有与被压的牌相同花色的真牌（单张也可），可以抢先接牌（插队）；
// 插队跳过了被响应者与无名之间的玩家，接完后被响应者摸 X 张，
// X = 响应牌中同花色真牌的点数总和（如被压 ♠5♥6♦7、无名出 ♣6♦7♠8 → X = 7+8 = 15），
// 轮转从无名的下家继续。普通响应（非插队）同样触发：被响应者摸 X，轮转正常继续。
// 插队机制与加牌由引擎提供（canCutIn），本文件只挂标志 + 播报。
import { isJoker } from '../cards';
import type { RoleDef } from './types';

const patrick: RoleDef = {
  id: 'patrick',
  seatOrder: 7,
  name: '第七席 圣帕特里克',
  skills: [
    { id: 'wu-ming', name: '无名', description: '响应牌中有与被压的牌相同花色的牌（单张也可）时可抢先接牌，被响应者摸 X 张（X = 同花色响应牌点数总和），接完从无名的下家继续。' },
  ],
  canCutIn: true,
  hooks: {
    afterPlay(ctx, played) {
      if (ctx.game.roundLastPlayerId() !== ctx.self.id) return;
      if (ctx.game.lastPlayWasCutIn()) {
        ctx.game.announce('patrick', 'wu-ming', '【无名】抢先接牌！');
        return;
      }
      // 普通响应（起牌不算）：响应牌中有与被压牌同花色的真牌 → 引擎令被响应者摸 X
      const respondedTo = ctx.game.respondedTo();
      if (respondedTo == null) return;
      const suits = ctx.game.respondedToSuits();
      const matched = played.cards.some((c) => !isJoker(c) && suits.includes(c.suit));
      if (matched) ctx.game.announce('patrick', 'wu-ming', '【无名】响应牌有同花色，被响应者摸 X 张');
    },
  },
};

export default patrick;
