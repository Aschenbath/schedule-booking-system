# 日程预约系统

面向装修公司内部的「老板日程预约」Web 系统：员工用自然语言和 AI 小助手对话发起预约，系统自动补齐信息、展开通知名单、检查时间冲突与车程，老板一键审批后写入日程、通知参会人，并在日程开始前弹出提醒。

- 前端：Vue 3 + Vite + vue-router（单页，五个页面，右上角下拉切换当前用户，无需登录）
- 后端：Node 24 + TypeScript + Hono，SQLite（Node 内置 `node:sqlite`，零外部依赖）
- AI：两段式 Agent —— 大模型只负责「听懂」（抽取增量信息）和「措辞」（流式回复），所有业务判断（缺什么、冲突、车程、名单展开、幂等）由代码完成；无 key 时自动切换到离线规则模式，功能不缩水
- 地图：内置模拟地图（默认），可切换高德 Web 服务 API；地图失败时如实标注「车程未核实」

设计文档见 [docs/DESIGN.md](docs/DESIGN.md)，演示脚本见 [docs/DEMO.md](docs/DEMO.md)。

## 一条命令启动

要求 Node ≥ 22.13（推荐 24，`node:sqlite` 内置于 Node）。

```bash
npm install
npm start          # 构建前端并启动服务，浏览器打开 http://localhost:3000
```

首次启动会自动写入种子数据（30 位联系人、9 个部门、15 条老板日程）。默认不需要任何 API key：大模型走离线规则模式，地图走内置模拟服务。

开发模式（后端热重载 + Vite 热更新，前端在 5173 端口，`/api` 自动代理到 3000）：

```bash
npm run dev
```

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm test` | 运行全部离线自动化测试（30 个，不依赖网络和 key） |
| `npm run smoke` | 对**已启动**的服务跑一遍端到端冒烟（对话→流式→名单→提交→审批→通知→实时流→静态页）。会真实创建并审批一条请求，演示前请 `npm run reset` |
| `node scripts/try-chat.mjs u004 < 句子.txt` | 命令行试聊：把文件里每一行依次发给小助手，打印回复与草稿要点，方便调提示词 |
| `npm run reset` | 删除本地数据库，下次启动重新灌入种子数据 |
| `npm run probe` | 探测 `.env` 里配置的大模型接口是否可用（不会打印 key） |

## 覆盖“当前时间”（NOW）

系统所有时间判断（相对时间解析、冲突、提醒、“已过则顺延”）都基于可覆盖的时钟，时区固定 `Asia/Shanghai`。

```bash
# Windows PowerShell
$env:NOW="2026-09-23T09:44:00"; npm start
# macOS / Linux
NOW=2026-09-23T09:44:00 npm start
```

- `NOW_MODE=offset`（默认）：以 NOW 为锚点，之后时钟正常前进——便于演示“到点弹提醒”。
- `NOW_MODE=frozen`：时间完全冻结在 NOW。
- 也可以写进 `.env`。页面右上角和「后台设置」页会显示当前生效的时间及是否被覆盖。
- 种子日程按 NOW 所在日期的相对天数生成（第 0 天到第 12 天），换 NOW 后执行 `npm run reset` 再启动即可重新对齐。

## 配置（`.env`）

复制 `.env.example` 为 `.env`（`.env` 已在 `.gitignore` 中，不会被提交）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NOW` / `NOW_MODE` | 空 / `offset` | 见上 |
| `PORT` | `3000` | 服务端口 |
| `DB_PATH` | `./data/app.db` | SQLite 路径（相对 `server/` 目录） |
| `LLM_PROVIDER` | `rules` | `rules` 离线规则模式；`openai` 任意 OpenAI 兼容接口 |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | 兼容接口地址（需带 `/v1`） |
| `LLM_API_KEY` | 空 | 为空时即使 `LLM_PROVIDER=openai` 也会回退到规则模式 |
| `LLM_MODEL` | `gpt-4o-mini` | 模型名 |
| `LLM_TIMEOUT_MS` | `30000` | 单次调用超时；超时或报错自动回退到规则模式，对话不中断 |
| `MAP_PROVIDER` | `mock` | `mock` 内置模拟地图；`amap` 高德 Web 服务 API |
| `AMAP_KEY` | 空 | 高德 key（免费额度足够演示） |

配置好大模型后先跑 `npm run probe`，通过再启动。规则模式与大模型模式走同一套业务代码，测试全部在规则模式下运行，保证可离线、可复现。

## 功能一览

| 需求 | 实现位置 |
| --- | --- |
| 五个页面：预约对话 / 待批准 / 日程 / 提醒中心 / 后台设置，下拉切换用户 | `web/src/views/*`，`web/src/App.vue` |
| 类别识别（会议/接待/饭局/其他），判不准就问一句 | `server/src/agent/agent.ts`，`llm/rules.ts` |
| 按类别追问缺失字段，一轮最多两个问题 | `agent/schema.ts` 的必填字段表 + `missingFields` |
| 相对时间（明天下午3点 / 下周二上午 / 改到5点） | `server/src/time/parse.ts` |
| 部门 / 岗位标签 → 具体人员，列在界面里让员工确认 | `agent/people.ts`，对话里的「通知名单」卡片 |
| 流式回复 | `POST /api/conversations/:id/messages` 返回 SSE |
| 刷新不丢、改口不丢已收集信息 | 对话与草稿都在 SQLite（`conversations.draft_json`） |
| 时间冲突 + 车程核实（“时间上不冲突，但车程赶不上”+ 建议） | `agent/schedule.ts` |
| 地图失败 → 对话与审批卡片都标“车程未核实”，不假装算过 | `map/index.ts` 的 `FailingMapService`，后台可开关模拟故障 |
| 老板审批 → 写日程、通知参会人（发起人不必确认参会），可改时间/拒绝 | `services/requests.ts` |
| 提交 / 审批幂等 | 幂等键唯一索引 + `events.request_id UNIQUE` + 事务内条件更新 |
| 开始前 N 分钟提醒：类别/主题/起止/地点/参与人/备注 + 地图导航链接 | `services/reminders.ts`，通知里的 `navUrl` |
| 实时弹窗、错过的提醒只弹一次、多标签页不重复 | `services/notifications.ts` 的 Hub：每条通知只投递到同一用户的一个连接 |
| ≥10 条离线自动化对话测试，含 ≥3 条失败路径 | `server/test/scenarios.test.ts` S1–S12 |
| 手机端 | 响应式布局，`web/src/style.css` |

## 测试

```bash
npm test
```

- `scenarios.test.ts`：12 个端到端对话场景（S1–S12），全部离线（规则模式 + 模拟地图 + 冻结时钟）。失败路径：S5 地图接口失败、S6 部门展开为空、S7 中途改口，另有 S11 重复提交/重复审批、S12 取消。
- `time.test.ts`：相对时间解析与改口合并。
- `people.test.ts`：部门 / 岗位标签 / 姓名展开。
- `approval.test.ts`：审批、改时间、拒绝、RSVP、提醒只建一次、错过的提醒只投递一次。

## 目录

```
server/            后端（Hono + node:sqlite）
  src/agent/       两段式 Agent：schema / people / schedule / reply / agent
  src/llm/         rules（离线）/ openai（兼容接口）/ prompts
  src/map/         mock / amap / failing 地图服务
  src/services/    requests / notifications / reminders
  src/http/app.ts  REST + SSE 路由
  src/time/        中文相对时间解析
  test/            Vitest 离线测试
web/               前端（Vue 3 + Vite）
scripts/           smoke / reset-db / probe-llm
docs/              DESIGN.md（设计文档）、DEMO.md（演示脚本）
```

## 已知取舍

- 没有登录，用户身份通过右上角下拉切换（题目要求）；老板专属操作（审批、改设置）由服务端按用户校验。
- 模拟地图用直线距离折算驾车时长，数值仅用于演示逻辑；接入高德后为真实路径耗时。
- 规则模式的中文理解覆盖了题目要求的表达方式，遇到更自由的说法会追问而不是猜；接入大模型后抽取更自然，但业务判断仍由代码兜底。
