# 角色开发规范（★ 未来工作核心文件）

**加一个角色 = 在 `shared/src/roles/` 放一个文件（`export default RoleDef`），零其他改动。** node/client 两个 loader 自动发现，注册表校验唯一性。9 个已实现角色就是最好的模板（见文末表）。带席位前缀的角色记得填 `seatOrder`（1=首席…），选角列表按席位序展示。

## RoleDef 接口（shared/src/roles/types.ts）

```ts
interface RoleDef {
  id: string;                 // kebab-case 唯一（注册表校验，重复报错）
  seatOrder?: number;         // 席位顺序：选角列表展示排序（1=首席…9=末席）；可选，不填排在已编号角色之后
  name: string;               // 中文角色名，如 '首席 杰杰一世'
  skills: SkillDef[];         // 技能列表（1-2 个）：{ id, name, description, locked? }
  maxPerRoom?: number;        // 同一房间最多几人选，默认 1
  priority?: number;          // 钩子执行顺序：大者先，同优先级按座位序（确定性）
  hooks?: Partial<RoleHooks>; // 用到哪些钩子写哪些
  setup?(ctx: RoleSetupContext): unknown; // 角色私有状态：JSON 安全，随快照同步
  skillActions?: SkillActionDef[]; // 客户端技能按钮：{ skillId, when:'myTurn'|'following', label }，通用渲染
  canCutIn?: boolean;         // 可插队响应（无名）——引擎提供插队机制，角色只挂标志
}
```

## 10 个钩子

| 钩子 | 时机 | 说明 |
|---|---|---|
| `onDeal(ctx)` | 发牌时 | 可 `extraDealCards`（仅此钩子可用） |
| `onTurnStart(ctx)` | 轮到出牌 | 任意 modify |
| `beforePlay(ctx, proposed)` | **引擎基础规则校验之后** | `allowAnyway` 放行 / `ok:false` 否决（技能优先） |
| `afterPlay(ctx, played)` | 出牌后 | 任意 modify |
| `onPlayInterrupt(ctx, played)` | 出牌提交后、**获胜判定前**（驱逐类优先于获胜，如巨石） | 可返回 ask 挂起 |
| `onPass(ctx)` | 过牌 | 任意 modify |
| `onDraw(ctx, n)` | 摸牌（n=本次摸牌数） | `drawBonus` |
| `onRoundEnd(ctx, lastPlayerId)` | 一轮结束（lastPlayerId=最后出牌者，牌权所在） | 可返回 ask 挂起（黑脸/观股）；`suppressDraw` 替代摸牌 |
| `onGameEnd(ctx, winnerId)` | 终局记分 | `scoreDelta` |
| `onSkillAction(ctx, req)` | 主动技动作（game:useSkill 触发，如茄汤/骚骚） | 可返回 ask 做多阶段交互 |

## HookResult 与技能优先

```ts
type HookResult =
  | { ok: true; modify?: ActionMods; allowAnyway?: boolean; ask?: SkillAsk }
  | { ok: false; reason: string };   // 中文原因，前端直接展示
```

**技能优先原则（用户定稿）**：技能与基础规则冲突时技能生效。实现 = 每个判定点走「基础规则校验 → 角色钩子覆写」两段管线：

- `beforePlay` 在引擎规则校验**之后**运行：
  - `allowAnyway: true` → 放行基础规则禁止的出牌（如「蛋神」Q 压 K、「斜视」差 0/1 即接）
  - `ok: false` → 否决基础规则允许的出牌（如「仁德」最后一张不得为 Q）
- 多个钩子结果合并：任一 `ok:false` 否决；`modify` 叠加
- 引擎不做任何"哪个优先"的特判

## 技能询问（ask）系统

可选技能需要玩家交互（确认/选花色/选项/选牌/选目标/插队）时，钩子返回 `ask`，引擎把动作挂起（pendingAsk），服务端把完整询问发给被询问者（`game:skill-ask`），玩家用 `game:useSkill` 回答后**只重跑提问钩子**（带 `ctx.answer`）。

```ts
interface SkillAsk {
  askId?: string;             // 引擎自动生成，角色不填
  kind: 'confirm' | 'suit' | 'choice' | 'pickCards' | 'pickTarget' | 'cutIn';
  prompt: string;             // 中文提示
  options?: string[];         // suit / choice 的候选项（答案 = 所选选项文本）
  cards?: Card[];             // pickCards 的可选牌（自己/目标手牌或展示牌）
  min?: number; max?: number; // pickCards 数量限制
  targetCandidates?: string[];// pickTarget 的候选玩家
  hidden?: boolean;           // pickCards 盲抽：客户端只显示牌背（如骚骚摸对面牌），
                              // 服务端经 currentAsk 下发时自动把牌面掩码（id 保留回传），角色照常传真牌即可
  askPlayerId?: string;       // 被询问的玩家 id，缺省 = 技能所有者；「依次自选」类技能用来依次问其他人
                              //（服务端只发给被询问者；resolveAsk 校验回答者 = 被询问者，引擎零额外改动）
  timeoutMs?: number;         // 缺省 15s，超时服务端自动按弃权处理
}
```

**纯度契约（★ 最重要）**：返回 `ask` 之前**不得改动任何状态**（不摸牌、不翻牌、不记 state）——回答后引擎会带着 `ctx.answer` 重跑钩子，改过状态就会重复生效。状态只写在"拿到 answer 之后"的分支里。

**多阶段询问**（骚骚 5 段 / 观股大跌 2 段 / 观股大涨依次自选）：钩子按 `ctx.answer` 分派。**依次问别人**用 `askPlayerId` 定向 + 私有状态队列（观股大涨范式）：state 存 `{ pool: Card[]; boom: { ids: string[]; next: number } }`，确认后 `revealTop` 存入 pool、返回指向队列首位的 pickCards；每次回答（含弃权/超时）处理当前位 → 指向下一位重新返回 ask（此时 `askPlayerId` 指向别人，重跑时 `ctx.self` 仍是技能所有者）；队列走完 discard 余牌收尾。注意弃权路径也必须能走完队列并清空展示池（守恒断言）。

```ts
onSkillAction(ctx, req) {
  const a = ctx.answer;
  if (!a) return { ok: true, ask: { kind: 'confirm', prompt: '是否发动？' } };
  if (a.choice === 'decline') return;                       // 弃权 = 什么都没发生
  if (a.choice === 'yes') return { ok: true, ask: { kind: 'pickCards', cards: [...ctx.self.hand], min: 2, max: 2 } };
  if (a.cardIds) { /* 这里才执行效果 */ }
}
```

注意：多阶段中间态（如"已翻的展示牌"）存 `setup()` 私有 state，重跑时复用（见 zecheng.ts 的 `revealedIds`）。引擎保证多阶段重挂起期间牌局处于暂停状态。

## ActionMods（有界词汇表）

```ts
interface ActionMods {
  drawBonus?: number;        // 该玩家下一次摸牌额外 +N
  skipNextPlayers?: number;  // 跳过接下来 N 名玩家（回合顺序）
  forcePass?: string[];      // 指定玩家下一回合强制过
  scoreDelta?: number;       // 终局记分修正（加在输赢分上）
  extraDealCards?: number;   // 仅 onDeal：额外发牌
  suppressDraw?: boolean;    // 跳过本轮结束的自动摸牌（角色自行摸牌，如黑脸/观股）
  endTurn?: boolean;         // 技能动作结束后立即轮到下家（换牌类技能，如骚骚）
  eliminate?: string[];      // 淘汰指定玩家（手牌进弃牌堆、记 −1，仅剩一人时其直接获胜）
  seizeLead?: boolean;       // 桌面作废，由技能所有者重新起牌（如巨石驱逐成功）
}
```

## EngineFacade（只读视图 + 受控操作）

角色**永远不能**直接碰引擎结构，只能通过：

- 只读：`cfg` `players()` `handOf(id)` `deckCount()` `table()` `turnPlayerId()` `roundLeaderId()` `phase()` `passCount()` `roundLastPlayerId()` `nextSeatOf(id, skip?)` `eliminated(id)` `activeCount()` `lastPlayWasCutIn()`
- 受控操作：
  - `draw(playerId, n)`（原始摸牌，不吃钩子不吃 drawBonus）
  - `giveFrom(playerId, cardIds)`（移除指定牌）+ `giveTo(playerId, cards)`（塞牌，**必须配合 giveFrom**，角色作者自己保证来源合法）
  - `announce(roleId, skillId, text)`（广播技能播报，前端 Toast「【技能名】text」）
  - **翻牌池**（判定类技能）：`revealTop(n, purpose?)`（翻牌堆顶 n 张到展示区；**每次调用都向全场广播一条 cards:revealed 事件**，purpose 供前端展示区标注，如「黑脸判定」「观股」）→ `takeRevealed(pid, ids)`（判定牌进手牌，**本回合豁免手牌上限**）/ `giveRevealed(pid, ids)`（普通拿取，计入手牌上限）/ `discardRevealed(ids?)`（弃置）。**动作结束前展示区必须清空**，否则引擎抛「翻牌池未清空」——多阶段询问中间可以暂存，最终收尾分支必须处理；挂起期间快照的 `revealed` 字段会把池中牌发给**所有玩家**（判定牌公开）
  - `revealCards(cards, purpose)`（公开亮牌，如茄汤展示手牌，广播 cards:revealed 事件）
  - `playForcedCombo(combo)`（打出特殊组合，引擎按正常出牌流程提交，如茄汤黑牌炸弹）
  - `attributeTable(ownerId)`（**桌面一手牌归属改写**，阿色再问：这手牌视作 ownerId 打出——tableOwner/轮末牌权/当前回合全部改到 ownerId，随后轮转从 ownerId 的下家继续；**先于其他角色的判定钩子执行**（角色 priority 设高，如 900），这样「视作谁打出」的判定才会落到新归属者身上；归属后原出牌者手牌已空也不判胜（引擎只判新归属者））
  - `setTableResponderRestrict(designatedId | null)`（**响应限制**，阿色抽你：当前桌面一手牌只有 designatedId 能响应——出牌/自动过候选/插队邀请/插队答案四处全部校验；被指定者淘汰/掉线时限制继续有效（无人能响应只能全过）；null 解除；桌面一手牌被压/轮末/新轮起牌自动清除，归属改写后需重新设置）
  - `playSideCard(playerId, cardId)`（**明置桌旁**，阿色再问补打：从手牌移除一张明置到桌旁，公开进快照 `tableSide`，随当前一手牌一起弃置；压牌者作答时用它，`handOf` 校验 + 自己校验合规性）

未来需要新的改牌能力 = 在 ActionMods / facade 加一个字段，不动引擎核心。

## 模板（照抄改，以末席 肖亡为例）

```ts
// 角色：末席 肖亡 —— 技能【观股】。
import { cardColor } from '../cards';
import type { RoleDef } from './types';

interface ZechengState {
  revealedIds: number[] | null; // 大跌选牌阶段暂存（询问恢复时复用，避免重复翻牌）
}

const zecheng: RoleDef = {
  id: 'zecheng',
  name: '末席 肖亡',
  skills: [{ id: 'guan-gu', name: '观股', description: '拥有牌权时摸牌改为展示 5 张：红多大涨每人 1 张，否则大跌自己拿 2 张。' }],
  setup(): ZechengState {
    return { revealedIds: null };
  },
  hooks: {
    onRoundEnd(ctx, lastPlayerId) {
      if (lastPlayerId !== ctx.self.id) return;   // 只有自己有牌权才触发
      const st = ctx.state as ZechengState;
      const a = ctx.answer;
      if (!a) {
        return { ok: true, ask: { kind: 'confirm', prompt: '是否发动【观股】？展示 5 张：红多则大涨，否则大跌' } };
      }
      if (a.choice === 'decline') return;          // 弃权 → 正常摸牌
      // ……拿到 answer 后才翻牌/发牌/弃置，最后 suppressDraw 替代摸牌
      return { ok: true, modify: { suppressDraw: true } };
    },
  },
};

export default zecheng;
```

## 已有 9 个角色（模板）

| 文件 | 角色 | 技能 | 用到的机制 |
|---|---|---|---|
| skywalker.ts | 首席 杰杰一世 | 蛋神 + 仁德 | 双技能；beforePlay allowAnyway/veto |
| elm-yao.ts | 第二席 圣母 | 斜视 | beforePlay allowAnyway（同长度差 0/1，任意牌型） |
| unhumanity.ts | 第三席 儒艮 | 黑脸 | onRoundEnd ask + takeRevealed 判定循环 + suppressDraw |
| flashpoint.ts | 第四席 阿毛 | 茄汤 | onSkillAction + revealCards + playForcedCombo |
| yy-xue.ts | 第五席 雪灾天使 | 巨石 | onPlayInterrupt ask(花色) + eliminate/seizeLead |
| cs-champion.ts | 第六席 企鹅 | 骚骚 | onSkillAction 四段 ask + giveFrom/giveTo 换牌 + endTurn |
| patrick.ts | 第七席 圣帕特里克 | 无名 | canCutIn 引擎级插队 |
| zecheng.ts | 末席 肖亡 | 观股 | onRoundEnd ask + revealTop + giveRevealed + suppressDraw |
| captain.ts | 第九席 阿色 | 抽你 + 再问 | beforePlay/afterPlay/onRoundEnd 多阶段 ask + 响应限制 + 归属改写 + 明置边牌 |

## 新增角色的流程（每个角色照此执行）

1. 用户给出角色名 + 技能描述（中文，可能与基础规则冲突）；**实现前先与用户确认技能细节**
2. **先想清楚映射**：技能对应哪个钩子 + 哪个 ActionMods / facade 操作；现有词汇表不够 → 和用户确认后扩展（引擎核心不动）
3. 在 `shared/src/roles/` 新建 `pinyin-name.ts`，写 RoleDef
4. 新建 `shared/src/roles/pinyin-name.test.ts`：精确效果断言（含 setup 状态变化、ask 多阶段、announce 文案、与基础规则冲突时的技能优先行为）；loader 测试期望列表同步更新
5. 验证：`npm test` 全绿 → 三包 tsc → `npm run build -w client` → `npm run smoke` → 服务器套件 15× 防抖
6. 前端角色卡片（RoleCard）自动展示 skills，无需改 UI；技能播报经 `announce` 自动进 Toast；技能按钮由 `skillActions` 通用渲染；询问弹窗由 ask 类型通用渲染
7. 更新 `docs/01-requirements.md` 的角色表 + 当天 dev-log

## 红线

- ❌ 不改引擎核心（engine.ts 只允许动 ActionMods/钩子分发的 bug 修复）
- ❌ 不绕过 EngineFacade（直接 import 引擎内部函数、篡改手牌数组）
- ❌ 返回 ask 之前改状态（纯度契约：重跑钩子会重复生效）
- ❌ 钩子内做非确定性操作（Math.random、Date.now）——一切随机走 `ctx.rng`
- ❌ 异步钩子、抛异常（异常会终止牌局；防御性写代码）
- ❌ 状态放模块级变量（会跨房间串）——私有状态一律 `setup()` 返回
- ❌ 翻牌后不清空展示池（引擎守恒断言直接报错）
- ✅ 不确定规则 → 先问用户，不自己拍板
