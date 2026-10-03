# Socket.IO 协议规范

定义在 `shared/src/protocol/messages.ts`（`CLIENT_EVENTS` / `SERVER_EVENTS` / 类型），两端共用避免字符串漂移。

## 客户端事件（client → server）

| 事件 | payload | ack |
|---|---|---|
| `room:create` | `{name}` | `{ok:true, code, playerId, secret}`（6 位数字房号） |
| `room:join` | `{code, name}` | 同上 |
| `room:rejoin` | `{code, playerId, secret}` | `{ok:true}` 或 `{ok:false, error:'身份校验失败'}` |
| `role:select` | `{roleId}` | ok / 错误（'角色不存在'、'已被别人选择'） |
| `room:ready` | `{ready: boolean}` | ok / 错误 |
| `room:start` | — | ok / 错误（'只有房主可以开始游戏'、'至少需要 2 人'…） |
| `room:rematch` | — | ok（全员投票通过后回到房间重选角色/重新准备，房主开局，先手给上局赢家） |
| `room:leave` | — | 无 ack（空房间销毁） |
| `game:play` | `{cardIds: number[]}` | ok / `{ok:false, error: 中文原因}` |
| `game:pass` | — | 同上 |
| `game:useSkill` | `SkillUsePayload`（见下） | 同上 |

`SkillUsePayload`：有 `askId` = **回答技能询问**（`{askId, choice?, cardIds?, targetPlayerId?}`）；无 `askId` = **发动主动技**（`{skillId}` → onSkillAction）。

## 服务端事件（server → client）

| 事件 | payload |
|---|---|
| `room:updated` | `RoomState {code, phase:'lobby'|'playing'|'finished', hostId, players[], winnerId, scoreDeltas, totals, rematchVotes}` |
| `game:snapshot` | `GameSnapshot`（按接收者过滤：只有自己的 `hand` 非 null；含 `pendingAsk: {askId, playerId, kind, prompt, timeoutMs} \| null`；`revealed` 翻牌展示区**所有人可见**——判定牌公开，动作内须清空；`orderReversed` 当前牌序是否倒序（海棠洄游），`table` 牌型的 rank 已按当前牌序约定解析——倒序时 rank = 最高点数） |
| `game:event` | `GameEvent`（判别联合 + 自增 seq，见下） |
| `game:error` | 中文原因字符串 |
| `game:skill-ask` | 完整 `SkillAsk`（**只发给被询问者**——被询问者可由 `askPlayerId` 指定，缺省 = 技能所有者；重连时重发未决询问；`hidden: true` 的 pickCards 为盲抽，经 currentAsk 下发时牌面已掩码只留 id） |
| `score:list` | `{records}`（应答 score:list 请求） |

## GameEvent（shared/src/engine/events.ts）

`game:started {leaderId}` · `deal:done` · `turn:started {playerId}` · `cards:played {playerId, combo}` · `passed {playerId}` · `round:ended {lastPlayerId, drew}` · `cards:drawn {playerId, count}` · `cards:revealed {playerId, cards, purpose}`（**判定牌公开**：`revealTop` 每翻一次发一条，逐张可见；`revealCards` 整批亮牌） · `table:attributed {playerId, fromPlayerId, combo}`（**桌面一手牌归属改写**：这手牌视作 playerId 打出，轮转从其下家继续、判定对其生效） · `table:side {playerId, card}`（明置一张牌到桌旁，随当前一手牌一起弃置，公开） · `player:eliminated {playerId, reason}` · `skill:triggered {playerId, roleId, skillId, text}` · `game:ended {winnerId(null=流局), scoreDeltas, totals}`

## 技能询问时序

```
动作（play/pass/useSkill）→ 钩子返回 ask → 引擎挂起
→ 广播 game:snapshot（pendingAsk 非空）→ 定向 game:skill-ask（完整载荷）→ 启动 15s 超时
→ 被询问者 game:useSkill {askId, ...} → 引擎重跑提问钩子 → 广播新快照（pendingAsk 清空或多阶段重挂起）
→ 超时/掉线 → 服务端自动 {askId, choice:'decline'} 了结
```

客户端弹窗按 `kind` 渲染：confirm（是/否）、suit/choice（选项按钮，答案 = 所选选项文本）、pickCards（选牌 + 数量校验；`hidden` 时显示牌背盲抽）、pickTarget（目标按钮）、cutIn（自己的手牌选接牌组合）。

## 约定

- ack 统一 `{ok:true, ...数据} | {ok:false, error}`（`AckResult<T>`），错误文案中文、直接可展示
- 每次动作后服务端：`game:event` 广播 → `game:snapshot` 广播 → `room:updated` 广播（顺序固定）
- 客户端状态一律由广播驱动；ack 仅用于即时反馈（出错 Toast）
- 重连：socket connect 后若本地有 `{roomId, playerId, secret}`（localStorage `gdys-identity`）自动发 `room:rejoin`；失败清除身份回大厅
- 客户端选牌预览用 shared 的 `parseCombo/canBeat`，**"压不过"只提示不阻断**（技能可能豁免基础规则），最终以服务端 `game:error` 为准
