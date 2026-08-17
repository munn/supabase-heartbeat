# Supabase Heartbeat（中文文档）

> 🌐 English docs: [README.md](./README.md) · 中文在下方。

一个小型、通用的 Cloudflare Worker，用来防止**任意数量的 Supabase 免费版项目**被自动暂停。Supabase 免费计划在项目 7 天无活动后会自动暂停；这个 Worker 每天把每个配置好的项目 ping 一次，让它们保持活跃——不需要笔记本常开，也不需要在自己机器上跑 cron。

本仓库是从零重写的通用版保活 Worker，替代了早期写死单个 Supabase 项目的专用 worker。这个版本是**目标无关的**：加一个项目只要往配置里加一行，无需改代码、无需额外部署。

## 工作原理

- 一个 Worker，一个每日 cron（`0 9 * * *` UTC，落在 7 天暂停窗口内）。
- 每次触发读取 `SUPABASE_TARGETS` 密钥（一个项目 JSON 数组），对每个目标调用 `POST /rest/v1/rpc/keepalive`，使用其项目 API key（**推荐用 anon / 公开 key**，见下）。
- `keepalive()` 是一个极简 SQL 函数，返回 `now()`（见 `supabase/migrations/0001_keepalive_function.sql`），只触碰数据库、不依赖任何表。
- **失败纪律**：每个目标独立 ping，某一个失败不会中断其他目标。如果**任何**目标失败，Worker 会抛出一个**聚合错误并点名是哪个目标失败**，这样 Cloudflare 会把这次调用标红，你一眼就能看出哪个项目挂了。失败绝不被静默吞掉。
- **无 `fetch` handler**——这个 Worker 只是个定时器，不是 HTTP 端点（攻击面最小）。

## 项目结构

```
src/index.ts                       # worker（多目标 scheduled handler）
wrangler.toml                      # 名称 + 每日 cron + 单个 SUPABASE_TARGETS 密钥
supabase/migrations/
  0001_keepalive_function.sql      # 需在每个目标项目上应用的 keepalive() RPC
test/scheduled.test.ts             # 7 个测试：全成功 / 部分失败 / no-op / 坏配置 / 无 fetch
.dev.vars.example                  # 本地开发密钥模板（复制为 .dev.vars）
LICENSE                            # MIT
```

## 添加要保活的 Supabase 项目

每个项目需要做两件事：

### 1. 在该 Supabase 项目上安装 `keepalive()` RPC

Worker 调用 `public.keepalive()`，该函数必须存在于目标项目上。应用 `supabase/migrations/0001_keepalive_function.sql`：

- **SQL Editor**：Supabase 后台 → SQL → New query，粘贴文件内容运行。（会把 `keepalive()` 的 `EXECUTE` 授权给 `anon` 和 `service_role`。）
- **CLI**：`supabase migration new keepalive_function`，粘贴函数体，然后 `supabase db push`。

### 2. 把项目加进 `SUPABASE_TARGETS`

`SUPABASE_TARGETS` 是一个 JSON 数组，每一项 = 一个项目：

```json
[
  { "name": "my-dev",    "url": "https://XXXX.supabase.co", "apiKey": "..." },
  { "name": "client-x",  "url": "https://YYYY.supabase.co", "apiKey": "..." }
]
```

作为密钥设置（正式部署推荐）：

```bash
wrangler secret put SUPABASE_TARGETS
# 按提示粘贴上面的 JSON 数组
```

本地开发可复制 `.dev.vars.example` → `.dev.vars` 并填值（`.dev.vars` 已被 git 忽略，切勿提交）。

API key 从 Supabase 后台 → Project Settings → API 获取。

> **推荐：使用 `anon` / 公开 key**（标注为 "anon public"）。`keepalive()` 只做 `SELECT now()`，且已授权给 anon，低权限 key 就够用——你不必把 `service_role`（上帝）key 散落到每个要保活的项目上。当然 `service_role` key 也能用（如果你更喜欢，或 anon 访问被锁）。

## 部署（Cloudflare）

```bash
npm install
wrangler secret put SUPABASE_TARGETS      # 设置你的目标（见上文）
wrangler deploy                           # 单 worker，cron 在 wrangler.toml 中
```

验证：

- `wrangler deployments list` 显示 `supabase-heartbeat` script。
- Cloudflare Dashboard → Workers → `supabase-heartbeat` → Triggers 显示 `schedule: 0 9 * * *`。
- 首次自然 09:00 UTC 运行后（或本地用 `wrangler dev --test-scheduled` → `curl http://localhost:8787/__scheduled` 测试），到各目标项目的 Supabase 日志里看 `POST /rpc/keepalive`。

以后改目标，只需再次 `wrangler secret put SUPABASE_TARGETS`——无需改代码、无需重新部署逻辑。

## 停用某个目标

从 `SUPABASE_TARGETS` 里删掉对应条目（`wrangler secret put SUPABASE_TARGETS` 传入更短的数组）。如果你还想连 Supabase 项目本身一起删，去 Supabase 后台单独操作。

## 许可证

[MIT](./LICENSE)。随便用——只要它让你的数据库保持温暖，我们就开心。

## 说明 / 历史

- 最初的 keepalive 逻辑写在一个更大的业务 Worker 里，后来抽成独立的单项目 worker，最终泛化为本仓库这一通用、目标无关的版本。
- 空的 `SUPABASE_TARGETS` 是安全的 no-op（打一条 warning 日志，但不抛错）——所以一次没有配置任何目标的部署不会刷红告警。
