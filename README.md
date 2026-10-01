# 干瞪眼（线上版）

网页版**干瞪眼** + 三国杀式**角色技能**：2-8 人开局，每位玩家带一个角色，技能与基础规则冲突时**技能生效**。

- 首批 8 个角色：首席 杰杰一世（蛋神/仁德）、第二席 圣母（斜视）、第三席 儒艮（黑脸）、第四席 阿毛（茄汤）、第五席 雪灾天使（巨石）、第六席 企鹅（骚骚）、第七席 圣帕特里克（无名）、末席 肖亡（观股）
- 服务端权威判定，客户端零规则逻辑；断线重连、30s 倒计时自动过、战绩落盘、再来一局
- 技术栈：npm workspaces monorepo（shared 纯 TS 引擎 / server Node+Socket.IO / client React+Vite），全 TypeScript，全中文界面

## 本地运行

```bash
npm install      # 首次安装
npm run dev      # 开发：server:3000 + client:5173（手机访问 http://电脑IP:5173）
npm run build    # 生产构建
npm start        # 生产：http://localhost:3000 单端口托管前后端
npm test         # shared + server 全部测试
```

局域网对战（手机 + 电脑同一 WiFi）需在 Windows 防火墙放行 Node.js，详见 [docs/07-deploy.md](docs/07-deploy.md)。

## 云端部署

Render 免费档一键部署（代码推到 GitHub → Render 控制台 New → Blueprint 选仓库，`render.yaml` 自动生效），步骤见 [docs/07-deploy.md](docs/07-deploy.md)。

## 文档

- [docs/01-requirements.md](docs/01-requirements.md) 规则定稿
- [docs/02-architecture.md](docs/02-architecture.md) 技术架构
- [docs/03-protocol.md](docs/03-protocol.md) Socket.IO 协议
- [docs/04-role-dev-guide.md](docs/04-role-dev-guide.md) 角色技能开发规范（加角色 = 丢一个文件）
- [docs/05-testing.md](docs/05-testing.md) 测试与验收
- [docs/06-ui-design.md](docs/06-ui-design.md) UI 设计规范
- [docs/07-deploy.md](docs/07-deploy.md) 部署与运行
- [dev-log/](dev-log/) 开发日志
