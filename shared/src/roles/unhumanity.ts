// 角色：第三席 儒艮 —— 技能【黑脸】。
// 当你拥有牌权（一轮最后出牌者）时，摸牌改为判定：连续翻牌直到出现红色，获得所有黑色判定牌，
// 判定牌在本回合不计入手牌上限（红色判定牌弃置；牌堆耗尽即停止）。
import { cardColor, type Card } from '../cards';
import type { RoleDef } from './types';

const unhumanity: RoleDef = {
  id: 'unhumanity',
  seatOrder: 3,
  name: '第三席 儒艮',
  skills: [
    { id: 'hei-lian', name: '黑脸', description: '拥有牌权时摸牌改为判定直到红色，获得所有黑色判定牌（本回合不计上限）。' },
  ],
  hooks: {
    onRoundEnd(ctx, lastPlayerId) {
      if (lastPlayerId !== ctx.self.id) return;
      if (!ctx.answer) {
        return { ok: true, ask: { kind: 'confirm', prompt: '是否发动【黑脸】？摸牌改为判定直到红色，获得所有黑色判定牌' } };
      }
      if (ctx.answer.choice !== 'yes') return;
      // 判定循环直到红色（牌堆耗尽即停止）；每次 revealTop 单独广播一张，全场逐张可见
      const blacks: Card[] = [];
      let red: Card | null = null;
      while (ctx.game.deckCount() > 0 && !red) {
        const top = ctx.game.revealTop(1, '黑脸判定');
        const c = top[0]!;
        if (cardColor(c) === 'red') red = c;
        else blacks.push(c);
      }
      // 黑牌全拿（判定牌本回合不计手牌上限），红牌弃置
      ctx.game.takeRevealed(ctx.self.id, blacks.map((c) => c.id));
      ctx.game.discardRevealed();
      ctx.game.announce(
        'unhumanity',
        'hei-lian',
        blacks.length > 0
          ? `【黑脸】判定获得 ${blacks.length} 张黑色判定牌${red ? '' : '（牌堆已空）'}`
          : red
            ? '【黑脸】判定到红牌，未获得黑牌'
            : '【黑脸】牌堆已空，判定中止'
      );
      return { ok: true, modify: { suppressDraw: true } };
    },
  },
};

export default unhumanity;
