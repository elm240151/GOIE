# 干瞪眼（线上版）开发指引

网页版干瞪眼 + 三国杀式角色技能。npm workspaces monorepo（shared / server / client），全 TypeScript，全中文。

## 必读标准文件（docs/）

| 文件 | 内容 | 何时读 |
|---|---|---|
| [docs/01-requirements.md](docs/01-requirements.md) | 需求、定稿规则（与用户逐条确认过）、流局规则 | 改规则、对规则有疑问时 |
| [docs/02-architecture.md](docs/02-architecture.md) | 技术架构、引擎不变量、数据流 | 改引擎/服务端/结构时 |
| [docs/03-protocol.md](docs/03-protocol.md) | Socket.IO 事件协议、payload、ack 约定 | 改前后端通信时 |
| [docs/04-role-dev-guide.md](docs/04-role-dev-guide.md) | ★ 角色技能开发规范（加角色 = 丢一个文件） | **每次实现新角色技能前必读** |
| [docs/05-testing.md](docs/05-testing.md) | 测试矩阵、命令、烟测、手工验收清单 | 改完代码验收时 |
| [docs/06-ui-design.md](docs/06-ui-design.md) | 前端结构、文案集中、交互约定 | 改 UI 时 |
| [docs/07-deploy.md](docs/07-deploy.md) | 本地/局域网运行、生产构建、云部署占位 | 部署相关时 |

## 开发日志（dev-log/）

- 每天一份 `dev-log/YYYY-MM-DD.md`：当天完成事项 + 待办（**每个工作日结束前必须更新**）
- [dev-log/todos.md](dev-log/todos.md)：持续维护的待办清单（完成即划掉）

## 日常工作流程

1. 动手前先读相关 docs 文件，不确定的规则细节回查 01
2. 改完跑验收：`npm test`（shared 70 + server 11）+ 三包 tsc（`npx tsc -p shared/tsconfig.build.json --noEmit`、`npx tsc -p server/tsconfig.build.json --noEmit`、`npx tsc -p client/tsconfig.json --noEmit`）+ `npm run build -w client`
3. 端到端烟测：起服务后 `npx tsx scripts/smoke.ts`
4. 收尾更新 dev-log 当天文件 + todos.md

## 工作原则（用户要求）

- **稳定安全有效推进**：一次做一件事，不一口气堆功能；每个角色技能单独实现、单独测试、单独汇报
- 角色技能由用户逐个提供，实现前先确认技能细节
- **技能与基础规则冲突时，技能生效**（实现方式见 docs/04）
- 全部界面与文档中文
- 用户后续会提出 UI 调整要求，随时响应

## 当前进度

- ✅ Phase 0-1：脚手架 + 规则核心（牌型解析/管牌矩阵，单测全绿）
- ✅ Phase 2：游戏循环引擎（种子化模拟、牌守恒 162、零和、纯王死锁守卫）
- ✅ Phase 3：角色框架（RoleDef/钩子/双 loader，加角色=丢一个文件）
- ✅ Phase 4：服务端（房间/重连/自动过/战绩落盘/生产托管）
- ✅ Phase 5：前端 UI（大厅/房间/牌桌/战绩 + 预览 + 倒计时 + 技能 Toast + 断线恢复；烟测通过；用户已试玩认可）
- ✅ Phase 5.5：技能框架大扩展（手牌上限 20 淘汰、翻牌池、技能询问挂起、插队、多技能 RoleDef、主动技按钮）+ **首批 8 个角色**（首席蛋神/仁德、圣母斜视、儒艮黑脸、阿毛茄汤、雪灾天使巨石、企鹅骚骚、圣帕特里克无名、肖亡观股；3 个示例角色已删除）；server 14 + shared 108 测试全绿、15× 稳定、烟测通过
- ⏳ Phase 6：README（运行说明+防火墙）、房间链接分享、部署文档、动画/音效（见 dev-log/todos.md）
- ⏳ 约 32 个角色技能待用户逐个提供（已完成 12 个：+阿色抽你/再问、海棠洄游/隐匿、修勾答疑/狂吠、橐驼地坛/诅咒，见 dev-log/todos.md）

## 常用命令

```bash
npm run dev        # 开发（server:3000 + client:5173，手机访问 http://电脑IP:5173）
npm test           # shared + server 全部测试
npm run build      # 生产构建（client/dist + server tsc）
npm start          # 生产运行（http://localhost:3000，托管 client/dist）
npx tsx scripts/smoke.ts   # 双客户端端到端烟测（需先起 server）
```
