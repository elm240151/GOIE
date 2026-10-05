// 角色：保国（引路者·马场之王）—— 四技能角色：【见习】【反力矩】【五连鞭】【压腿】。
// 【见习】主动技（每局限 X+2 次，X = 人数）：保国起牌的回合（拥有牌权时）可指定一人见习：
//   保国私摸 2 张、暗交其中 1 张给目标（另 1 张留自己），目标本回合罚站——不得出牌、
//   不被任何人的技能选为目标；目标自己的技能仍可用。弃权不消耗次数；不能连续两回合见习同一人；
//   保国见习后照常出牌；见习不算打出（不触发洄游/亢奋等）。超上限照常淘汰。
// 【反力矩】主动技（无次数限制）：①保国起牌的回合 ②牌权被抢夺（上一回合保国起牌、
//   这一回合起牌的变成他人）时，任取一名角色拼点：双方从手牌各暗选 1 张（对方选时不知保国所选）
//   → 一起亮出；保国点数 +2，平局算保国输。保国赢 → 两张拼点牌都交给对方 + 保国自弃一张手牌；
//   保国输 → 保国获得两张拼点牌。发动后照常出牌。手牌不足 3 张不能发动
//   （赢家要交出一张拼点牌再弃一张，防手牌打空成僵尸）。
// 【五连鞭】（亡语，无次数限制）：有人打出一手 ≥5 张的牌（含保国自己、含插队/狂吠每一手/翻面接/
//   茄汤强制等一切打出路径；吃饼不算打出）时，保国可选令出牌者摸 1 张（牌堆空洗回等全局规则照常）。
// 【压腿】（亡语，无次数限制）：别人（不含保国）打出炸弹时，保国可与其拼点：双方从牌堆各翻 1 张公开，
//   保国 +2，失败方摸 |点差| 张（平局 = 保国输、差 0 无事）；两张拼点牌一律弃置；牌堆+弃牌堆都空则不询问。
// 拼点通用点数（2026-10-05 用户确认）：3~10 按牌面、J=11、Q=12、K=13、A=1、2=2、大小王都 = 14（保国 +2 后最大 16）。
// 亡语同场顺序（2026-10-05 用户确认）：旺旺(100) → 五连鞭 → 压腿 → 巨石(0)，故 priority 90。
import { isJoker, RANK_2, RANK_A, type Card } from '../cards';
import type { HookContext, HookResult, RoleDef } from './types';

interface BaoGuoState {
  /** 当前轮数（onTurnStart 换轮检测时自增；见习「不能连续两回合同一人」限制用） */
  roundCount: number;
  /** 本回合已见过的起牌者（换轮检测：不同 = 新一轮开始；null = 开局尚未见） */
  seenLeader: string | null;
  // 见习
  /** 已发动次数（每局限 X+2 次，X = 人数；弃权不消耗） */
  jianxiUsed: number;
  /** 最近一次见习目标与发生轮（不能连续两回合见习同一人） */
  jianxiLastTarget: string | null;
  jianxiLastRound: number;
  /** 见习阶段机：null = 空闲；'pick' = 待选目标；'give' = 待从私摸的牌里选 1 张暗交给目标 */
  jianxiStage: 'pick' | 'give' | null;
  jianxiTarget: string | null;
  /** 私摸到的牌 id（give 阶段的选择范围） */
  jianxiDrewIds: number[];
  // 反力矩
  /** 阶段机：confirm = 被动触发确认；pickTarget = 选拼点目标；selfPick = 保国暗选；targetPick = 对方暗选；discard = 获胜自弃 */
  fanliStage: 'confirm' | 'pickTarget' | 'selfPick' | 'targetPick' | 'discard' | null;
  fanliTarget: string | null;
  /** 保国暗选的拼点牌 id */
  fanliMyCard: number | null;
  // 五连鞭/压腿（同一打断钩子的两段阶段机）
  interruptStage: 'wlb' | 'yt' | null;
}

/** 拼点通用点数（反力矩/压腿共用）：3~10 按牌面、J=11、Q=12、K=13、A=1、2=2、大小王都 = 14 */
function contestPoint(c: Card): number {
  if (isJoker(c)) return 14;
  if (c.rank === RANK_A) return 1;
  if (c.rank === RANK_2) return 2;
  return c.rank;
}

function nameOf(ctx: HookContext, id: string): string {
  return ctx.game.players().find((p) => p.id === id)?.name ?? id;
}

/** 见习阶段机（onSkillAction 多阶段重跑）：选目标 → 私摸 2 张 → 选 1 张暗交给目标并罚站 */
function jianXiFlow(ctx: HookContext, st: BaoGuoState): HookResult | void {
  const a = ctx.answer;
  if (st.jianxiStage === 'give') {
    st.jianxiStage = null;
    const target = st.jianxiTarget!;
    st.jianxiTarget = null;
    // 从私摸的牌里选 1 张暗交给目标；超时/弃选 → 自动给第 1 张
    const hand = ctx.game.handOf(ctx.self.id);
    const drew = st.jianxiDrewIds.filter((id) => hand.some((c) => c.id === id));
    st.jianxiDrewIds = [];
    const pickId = a?.cardIds?.find((id) => drew.includes(id)) ?? drew[0];
    const tName = nameOf(ctx, target);
    if (pickId) {
      const card = hand.find((c) => c.id === pickId)!;
      ctx.game.giveFrom(ctx.self.id, [pickId]);
      ctx.game.giveTo(target, [card]);
      ctx.game.announce('bao-guo', 'jian-xi', `${tName} 收下 1 张暗牌并罚站：本回合不得出牌、不被技能响应`);
    } else {
      ctx.game.announce('bao-guo', 'jian-xi', `${tName} 本回合罚站：不得出牌、不被技能响应`);
    }
    ctx.game.banPlayThisRound(target);
    return;
  }
  if (st.jianxiStage === 'pick') {
    st.jianxiStage = null;
    const t = a?.targetPlayerId;
    const ok =
      !!t &&
      t !== ctx.self.id &&
      !ctx.game.eliminated(t) &&
      !ctx.game.isBannedThisRound(t) &&
      !(st.jianxiLastTarget === t && st.roundCount <= st.jianxiLastRound + 1);
    if (!ok) return; // 弃权/非法：不消耗次数
    st.jianxiUsed++;
    st.jianxiTarget = t;
    st.jianxiLastTarget = t;
    st.jianxiLastRound = st.roundCount;
    // 私摸 2 张（超上限照常淘汰；牌堆空则摸少）
    const before = ctx.game.handOf(ctx.self.id).length;
    ctx.game.draw(ctx.self.id, 2);
    if (ctx.game.phase() !== 'playing') return; // 摸牌致终局（淘汰只剩一人等）：后续无需进行
    const hand = ctx.game.handOf(ctx.self.id);
    st.jianxiDrewIds = hand.slice(before).map((c) => c.id);
    if (st.jianxiDrewIds.length === 0) {
      // 没摸到牌（含私摸超上限照常淘汰、手牌已清空）：无牌可交，直接罚站
      ctx.game.banPlayThisRound(t);
      ctx.game.announce('bao-guo', 'jian-xi', `${nameOf(ctx, t)} 本回合罚站：不得出牌、不被技能响应`);
      // 保国自己超上限被淘汰：让出回合（照常出牌无从谈起）
      return ctx.game.eliminated(ctx.self.id) ? { ok: true, modify: { endTurn: true } } : undefined;
    }
    st.jianxiStage = 'give';
    return {
      ok: true,
      ask: {
        kind: 'pickCards',
        prompt: `选择 1 张刚摸的牌暗交给 ${nameOf(ctx, t)}（另一张留给自己；超时自动交第 1 张）`,
        cards: st.jianxiDrewIds.map((id) => hand.find((c) => c.id === id)!),
        min: 1,
        max: 1,
      },
    };
  }
  // 首次进入（按钮触发）：校验次数与可选目标
  if (st.jianxiUsed >= ctx.game.players().length + 2) return { ok: false, reason: '【见习】本局次数已用尽' };
  const others = ctx.game
    .players()
    .filter(
      (p) =>
        p.id !== ctx.self.id &&
        !ctx.game.eliminated(p.id) &&
        !ctx.game.isBannedThisRound(p.id) &&
        !(st.jianxiLastTarget === p.id && st.roundCount <= st.jianxiLastRound + 1)
    )
    .map((p) => p.id);
  if (others.length === 0)
    return { ok: false, reason: '【见习】没有可见习的目标（不能连续两回合见习同一人）' };
  st.jianxiStage = 'pick';
  return {
    ok: true,
    ask: {
      kind: 'pickTarget',
      prompt: '指定一人见习：你摸 2 张牌暗交其 1 张，其本回合罚站（不得出牌、不被技能响应）',
      targetCandidates: others,
    },
  };
}

/** 反力矩：选拼点目标（双方从手牌各暗选 1 张 → 一起亮出；保国点数 +2，平局算保国输） */
function fanLiPickTarget(ctx: HookContext, st: BaoGuoState): HookResult | void {
  if (ctx.game.handOf(ctx.self.id).length < 3)
    return { ok: false, reason: '【反力矩】手牌不足 3 张不能发动（要交出一张拼点牌并弃置一张）' };
  const others = ctx.game
    .players()
    .filter((p) => p.id !== ctx.self.id && !ctx.game.eliminated(p.id) && !ctx.game.isBannedThisRound(p.id))
    .map((p) => p.id);
  if (others.length === 0) return { ok: false, reason: '【反力矩】没有可拼点的目标' };
  st.fanliStage = 'pickTarget';
  return {
    ok: true,
    ask: {
      kind: 'pickTarget',
      prompt: '任取一名角色拼点（你暗选一张、对方暗选一张后一起亮出，你的点数 +2，平局算你输）',
      targetCandidates: others,
    },
  };
}

/** 反力矩阶段机（onSkillAction 主动 / onTurnStart 被动共用） */
function fanLiFlow(ctx: HookContext, st: BaoGuoState): HookResult | void {
  const a = ctx.answer;
  switch (st.fanliStage) {
    case 'confirm': {
      if (!a) {
        // 被动触发（牌权被抢夺）首次进入：先询问是否发动
        return {
          ok: true,
          ask: {
            kind: 'confirm',
            prompt: '你的牌权被抢夺，是否发动【反力矩】？（任取一名角色拼点：双方暗选一张一起亮出，你的点数 +2，平局算你输）',
          },
        };
      }
      st.fanliStage = null;
      if (a.choice !== 'yes') return; // 弃权
      return fanLiPickTarget(ctx, st);
    }
    case 'pickTarget': {
      const t = a?.targetPlayerId;
      const ok = !!t && t !== ctx.self.id && !ctx.game.eliminated(t) && !ctx.game.isBannedThisRound(t);
      if (!ok) {
        st.fanliStage = null; // 弃权/非法：作罢
        return;
      }
      st.fanliStage = 'selfPick';
      st.fanliTarget = t;
      return {
        ok: true,
        ask: {
          kind: 'pickCards',
          prompt: '暗选一张拼点牌（你的点数 +2；选好后与对方一起亮出，超时作罢）',
          cards: [...ctx.game.handOf(ctx.self.id)],
          min: 1,
          max: 1,
        },
      };
    }
    case 'selfPick': {
      const myCard = ctx.game.handOf(ctx.self.id).find((c) => c.id === a?.cardIds?.[0]);
      if (!myCard) {
        st.fanliStage = null;
        st.fanliTarget = null;
        return; // 弃权/超时：作罢
      }
      st.fanliStage = 'targetPick';
      st.fanliMyCard = myCard.id;
      const t = st.fanliTarget!;
      if (ctx.game.handOf(t).length === 0) {
        st.fanliStage = null;
        st.fanliTarget = null;
        st.fanliMyCard = null;
        return; // 防御：目标无牌可拼
      }
      return {
        ok: true,
        ask: {
          kind: 'pickCards',
          prompt: '请暗选一张拼点牌与保国拼点（弃权/超时则作罢）',
          cards: [...ctx.game.handOf(t)],
          min: 1,
          max: 1,
          askPlayerId: t,
        },
      };
    }
    case 'targetPick': {
      st.fanliStage = null;
      const t = st.fanliTarget!;
      const myCardId = st.fanliMyCard!;
      st.fanliTarget = null;
      st.fanliMyCard = null;
      const tCard = ctx.game.handOf(t).find((c) => c.id === a?.cardIds?.[0]);
      const myCard = ctx.game.handOf(ctx.self.id).find((c) => c.id === myCardId);
      if (!tCard || !myCard) return; // 弃权/超时/牌已不在手：作罢（选牌阶段不动手牌）
      // 一起亮出（对方选时不知保国所选）
      ctx.game.revealCards([myCard, tCard], '反力矩拼点');
      const mine = contestPoint(myCard) + 2;
      const theirs = contestPoint(tCard);
      const tName = nameOf(ctx, t);
      if (mine > theirs) {
        // 保国赢：两张拼点牌都交给对方 + 保国自弃一张手牌
        ctx.game.giveFrom(ctx.self.id, [myCard.id]);
        ctx.game.giveFrom(t, [tCard.id]);
        ctx.game.giveTo(t, [myCard, tCard]);
        if (ctx.game.phase() !== 'playing') return; // 对方超上限淘汰/耀武等致终局：无需再弃
        const rest = ctx.game.handOf(ctx.self.id);
        ctx.game.announce('bao-guo', 'fan-li-ju', `拼点获胜（${mine} vs ${theirs}）：两张牌交给 ${tName}`);
        if (rest.length === 0) return;
        st.fanliStage = 'discard';
        return {
          ok: true,
          ask: {
            kind: 'pickCards',
            prompt: '获胜：请弃置一张手牌（超时自动弃第一张）',
            cards: [...rest],
            min: 1,
            max: 1,
          },
        };
      }
      // 保国输（含平局）：保国获得两张拼点牌（自己那张本就在手，收下对方那张即可）
      ctx.game.giveFrom(t, [tCard.id]);
      ctx.game.giveTo(ctx.self.id, [tCard]);
      ctx.game.announce('bao-guo', 'fan-li-ju', `拼点落败（${mine} vs ${theirs}）：两张牌归保国`);
      return;
    }
    case 'discard': {
      st.fanliStage = null;
      const hand = ctx.game.handOf(ctx.self.id);
      const pickId = a?.cardIds?.find((id) => hand.some((c) => c.id === id)) ?? hand[0]?.id;
      if (pickId) ctx.game.discardFromHand(ctx.self.id, [pickId]);
      return;
    }
    default:
      return;
  }
}

const baoGuo: RoleDef = {
  id: 'bao-guo',
  // 亡语同场顺序（2026-10-05 用户确认）：旺旺(100) → 五连鞭 → 压腿 → 巨石(0)
  priority: 90,
  // 亡语（2026-10-05 用户定稿）：出牌者打光手牌后五连鞭/压腿仍可触发（摸牌使其手牌非空、游戏继续）
  deathrattleHooks: ['onPlayInterrupt'],
  name: '保国',
  skills: [
    {
      id: 'jian-xi',
      name: '见习',
      description:
        '每局限 X+2 次（X = 人数）：拥有牌权（起牌回合）时指定一人见习，你摸 2 张牌暗交其 1 张，其本回合罚站（不得出牌、不被技能响应；自己的技能仍可用）。弃权不消耗；不能连续两回合见习同一人。',
    },
    {
      id: 'fan-li-ju',
      name: '反力矩',
      description:
        '拥有牌权或牌权被抢夺时，任取一名角色拼点：双方从手牌各暗选 1 张一起亮出，你的点数 +2（3~10 按牌面、J=11、Q=12、K=13、A=1、2=2、王=14），平局算你输。你赢 → 两张拼点牌都交给对方并自弃一张手牌；你输 → 你获得这两张牌。',
    },
    {
      id: 'wu-lian-bian',
      name: '五连鞭',
      description:
        '（亡语）有人打出一手 ≥5 张的牌时（含你自己、含插队/狂吠每一手/翻面接等一切打出；吃饼不算），你可令出牌者摸 1 张。',
    },
    {
      id: 'ya-tui',
      name: '压腿',
      description:
        '（亡语）别人打出炸弹时，你可与其拼点：双方从牌堆各翻 1 张公开，你的点数 +2，失败方摸 |点差| 张（平局算你输、差 0 无事），两张拼点牌一律弃置。',
    },
  ],
  setup(): BaoGuoState {
    return {
      roundCount: 0,
      seenLeader: null,
      jianxiUsed: 0,
      jianxiLastTarget: null,
      jianxiLastRound: 0,
      jianxiStage: null,
      jianxiTarget: null,
      jianxiDrewIds: [],
      fanliStage: null,
      fanliTarget: null,
      fanliMyCard: null,
      interruptStage: null,
    };
  },
  skillActions: [
    { skillId: 'jian-xi', when: 'myTurn', onlyWhenLeader: true, label: '见习' },
    { skillId: 'fan-li-ju', when: 'myTurn', onlyWhenLeader: true, label: '反力矩' },
  ],
  hooks: {
    onTurnStart(ctx) {
      const st = ctx.state as BaoGuoState;
      if (ctx.game.eliminated(ctx.self.id)) return;
      const leader = ctx.game.roundLeaderId();
      // 新一轮的第一个回合（轮首 roundLastPlayerId 为空）：轮数 +1。
      // 不能只看领袖变化——保国连续保住牌权时领袖不变但仍是新的一轮（见习「连续两回合」限制用）；
      // 只在无 answer 的首次进入自增（多阶段重跑不重复计数）。
      if (!ctx.answer && ctx.game.roundLastPlayerId() === null) st.roundCount++;
      if (st.seenLeader !== leader) {
        // 换轮：见到的第一个回合 = 新一轮起牌者的回合
        const wasMine = st.seenLeader === ctx.self.id;
        st.seenLeader = leader;
        // 反力矩被动：牌权被抢夺（上一回合保国起牌、这一回合起牌的变成他人）
        if (wasMine && leader !== ctx.self.id && ctx.game.handOf(ctx.self.id).length >= 3) {
          st.fanliStage = 'confirm';
          return fanLiFlow(ctx, st);
        }
        return;
      }
      // 被动反力矩的多阶段重跑
      if (st.fanliStage && ctx.answer) return fanLiFlow(ctx, st);
    },
    onSkillAction(ctx, req) {
      const st = ctx.state as BaoGuoState;
      if (req.skillId === 'jian-xi') return jianXiFlow(ctx, st);
      if (req.skillId === 'fan-li-ju') {
        if (st.fanliStage && ctx.answer) return fanLiFlow(ctx, st); // 多阶段重跑
        return fanLiPickTarget(ctx, st);
      }
      return;
    },
    onPlayInterrupt(ctx, played) {
      const st = ctx.state as BaoGuoState;
      const a = ctx.answer;
      const player = ctx.game.roundLastPlayerId()!;
      const name = nameOf(ctx, player);
      // 压腿适用性：别人（不含自己）打炸弹，且牌堆/弃牌堆至少一边有牌可翻
      const ytApplies =
        played.type === 'bomb' &&
        player !== ctx.self.id &&
        !(ctx.game.deckCount() === 0 && ctx.game.discardCount() === 0);
      const ytPrompt = `${name} 使用了炸弹，是否与其拼点？（双方从牌堆各翻 1 张，你的点数 +2，失败方摸 |点差| 张）`;
      if (!a) {
        st.interruptStage = null; // 新一手：重置阶段
        if (played.cards.length >= 5) {
          st.interruptStage = 'wlb';
          return {
            ok: true,
            ask: {
              kind: 'confirm',
              prompt: `${name} 打出了 ${played.cards.length} 张牌，是否令其摸 1 张？`,
            },
          };
        }
        if (ytApplies) {
          st.interruptStage = 'yt';
          return { ok: true, ask: { kind: 'confirm', prompt: ytPrompt } };
        }
        return;
      }
      if (st.interruptStage === 'wlb') {
        st.interruptStage = null;
        if (a.choice === 'yes') {
          ctx.game.draw(player, 1);
          ctx.game.announce('bao-guo', 'wu-lian-bian', `${name} 摸 1 张`);
        }
        if (ctx.game.phase() !== 'playing') return;
        if (ytApplies) {
          st.interruptStage = 'yt';
          return { ok: true, ask: { kind: 'confirm', prompt: ytPrompt } };
        }
        return;
      }
      if (st.interruptStage === 'yt') {
        st.interruptStage = null;
        if (a.choice !== 'yes') return;
        // 压腿拼点：双方从牌堆各翻 1 张公开（第 1 张 = 保国的拼点牌）
        const top = ctx.game.revealTop(2, '压腿拼点');
        if (top.length < 2) {
          ctx.game.discardRevealed();
          ctx.game.announce('bao-guo', 'ya-tui', '牌堆已空，无法拼点');
          return;
        }
        const mine = contestPoint(top[0]!) + 2;
        const theirs = contestPoint(top[1]!);
        ctx.game.discardRevealed(); // 两张拼点牌一律弃置
        const diff = Math.abs(mine - theirs);
        if (mine > theirs) {
          ctx.game.announce('bao-guo', 'ya-tui', `拼点获胜（${mine} vs ${theirs}）：${name} 摸 ${diff} 张`);
          ctx.game.draw(player, diff);
        } else {
          ctx.game.announce('bao-guo', 'ya-tui', `拼点落败（${mine} vs ${theirs}）：保国摸 ${diff} 张`);
          ctx.game.draw(ctx.self.id, diff);
        }
        return;
      }
    },
  },
};

export default baoGuo;
