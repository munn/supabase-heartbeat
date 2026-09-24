# Supabase Heartbeat（中文文档）

> 🌐 English docs: [README.md](./README.md) · 中文在下方。

一个小型、通用的 Cloudflare Worker，定时向多个 Supabase 免费版项目发起数据库查询，以降低因低活动量被自动暂停的可能。可通过 Data API 的 RPC 或 PostgreSQL 连接工作；后者适用于关闭 Data API 的项目。不需要笔记本常开。

本仓库是从零重写的通用版保活 Worker，替代了早期写死单个 Supabase 项目的专用 worker。加 RPC 目标只需更新配置密钥；加关闭 Data API 的目标还需创建并绑定一个 Hyperdrive 连接。

## 工作原理

- 一个 Worker，每天三次运行（UTC 01:00、09:00、17:00）。[Supabase 官方说明](https://supabase.com/docs/guides/platform/free-project-pausing)称每天几次用户数据库请求通常足够，但**不保证**任何固定频率一定能避免暂停。
- 每次触发读取 `SUPABASE_TARGETS` 密钥（一个项目 JSON 数组）。每个目标使用一种方式：Data API 开启时调用 `POST /rest/v1/rpc/keepalive`；Data API 关闭时经 Cloudflare Hyperdrive 连接 PostgreSQL 并执行 `SELECT now()`。
- RPC 目标需要安装 `keepalive()` SQL 函数；PostgreSQL 目标不需要安装函数，也不依赖任何表。
- **失败纪律**：每个目标独立 ping，某一个失败不会中断其他目标。如果**任何**目标失败，Worker 会抛出一个**聚合错误并点名是哪个目标失败**，这样 Cloudflare 会把这次调用标红，你一眼就能看出哪个项目挂了。失败绝不被静默吞掉。
- **无 `fetch` handler**——这个 Worker 只是个定时器，不是 HTTP 端点（攻击面最小）。

## 已验证的运行状态（2026-09-24）

已有一个生产 Worker 同时保活两个项目：Data API 开启的项目通过 RPC，关闭的项目通过 PostgreSQL/Hyperdrive。首次正式 Cron 于 2026-09-24 01:01 UTC 在 Cloudflare 历史记录中显示成功；同次 Worker 日志中两种方式均为 `OK`，其中 RPC 返回 HTTP 200。PostgreSQL 项目的专用角色 `SELECT now()` 调用计数也在该次运行后增加 1。此前还通过 Cloudflare 远程预览分别即时验证了两条路径。

仓库中的 `wrangler.toml` 是通用模板，**不包含生产 Hyperdrive ID 或数据库凭据**。复现关闭 Data API 的部署时，先在不提交到 Git 的配置副本中填入实际绑定和 ID，再用该配置部署；仅运行下方的模板部署命令不会带上生产 Hyperdrive 绑定。上述一次成功运行不保证 Supabase 永不暂停。

## 项目结构

```
src/index.ts                       # worker（多目标 scheduled handler）
wrangler.toml                      # 名称 + 定时 cron + Hyperdrive 绑定位置
supabase/migrations/
  0001_keepalive_function.sql      # 仅 RPC 目标需要安装
test/scheduled.test.ts             # 定时任务、两种连接方式和配置失败测试
.dev.vars.example                  # 本地开发密钥模板（复制为 .dev.vars）
LICENSE                            # MIT
```

## 添加要保活的 Supabase 项目

根据该项目是否开启 Data API，配置对应方式。

### Data API 已开启：使用 RPC

Worker 调用 `public.keepalive()`，该函数必须存在于目标项目上。应用 `supabase/migrations/0001_keepalive_function.sql`：

- **SQL Editor**：Supabase 后台 → SQL → New query，粘贴文件内容运行。（会把 `keepalive()` 的 `EXECUTE` 授权给 `anon` 和 `service_role`。）
- **CLI**：`supabase migration new keepalive_function`，粘贴函数体，然后 `supabase db push`。

### Data API 已关闭：使用 PostgreSQL

1. 在 Supabase Dashboard → **Connect → Session pooler** 复制连接串（端口 **5432**），替换 `[YOUR-PASSWORD]`；密码里的 `@`、`#`、`/` 等特殊字符需按 URL 规则编码。免费项目的直连地址通常只支持 IPv6，Hyperdrive 到 IPv6-only 地址的可用性尚未在本项目验证，因此默认使用支持 IPv4 的 Session pooler。不要选端口 6543 的 Transaction pooler，也不要自己拼接 pooler 主机名。[Supabase 连接文档](https://supabase.com/docs/guides/database/connecting-to-postgres)
2. 在 Cloudflare Dashboard 创建一个指向该数据库的 **Hyperdrive** 配置，把连接串填入 Hyperdrive。关闭该配置的**查询缓存**，确保每次定时调用都真正到达数据库；数据库密码只放在 Cloudflare Hyperdrive，不放在 `SUPABASE_TARGETS` 或仓库。[Hyperdrive 缓存说明](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
3. 从 Supabase Dashboard → Database Settings → SSL Configuration 下载该项目的 CA 证书，上传到 Cloudflare，然后在 Hyperdrive 配置里选择 **verify-full** 和该 CA，确认证书覆盖 Session pooler 主机名。不要关闭证书验证。[Supabase SSL 说明](https://supabase.com/docs/guides/platform/ssl-enforcement) · [Hyperdrive TLS 配置](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
4. 在 `wrangler.toml` 加入一个 `[[hyperdrive]]` 条目，`binding` 例如 `DB_CLIENT_X`（本工具要求大写字母、数字和下划线，且以大写字母开头），`id` 填刚创建的 Hyperdrive 配置 ID。部署更新后的 Worker。每个关闭 Data API 的项目都需要自己的**专用、关闭缓存**的 Hyperdrive 配置和绑定；无需安装 SQL 函数。

### 把项目加进 `SUPABASE_TARGETS`

`SUPABASE_TARGETS` 是一个 JSON 数组，每一项 = 一个项目：

```json
[
  { "name": "my-dev",    "url": "https://XXXX.supabase.co", "apiKey": "..." },
  { "name": "client-x",  "hyperdrive": "DB_CLIENT_X" }
]
```

作为密钥设置（正式部署推荐）：

```bash
wrangler secret put SUPABASE_TARGETS
# 按提示粘贴上面的 JSON 数组
```

本地开发可复制 `.dev.vars.example` → `.dev.vars` 并填值（`.dev.vars` 已被 git 忽略，切勿提交）。

API key 从 Supabase 后台 → Project Settings → API 获取。

> **RPC 目标推荐使用 `anon` / 公开 key**（标注为 "anon public"）。Hyperdrive 目标的数据库账号密码保存在 Hyperdrive 配置中；`apiKey` 不能代替数据库密码。两种字段不能放在同一个目标中。

## 部署（Cloudflare）

```bash
npm install
wrangler deploy                           # 仅 RPC 目标可直接使用模板
wrangler secret put SUPABASE_TARGETS      # 部署后设置目标（见上文）
```

有 PostgreSQL 目标时，以上两条 Wrangler 命令都须指向同一份包含真实 Hyperdrive 绑定的私有配置（使用 `--config`）；不要直接部署仓库模板。私有配置放在 Git 忽略目录中，并用 `git check-ignore` 核实；如果配置不在仓库根目录，需按其位置修正 `main` 相对路径，同时保留 Cron 触发器和 Workers Logs 设置。

验证：

- `wrangler deployments list` 显示 `supabase-heartbeat` script。
- Cloudflare Dashboard → Workers → `supabase-heartbeat` → Triggers 显示 `schedule: 0 1,9,17 * * *`。
- 首次运行后看 Worker 日志是否显示各目标 `OK`；RPC 目标还可在 Supabase API 日志中核对 `/rpc/keepalive`。PostgreSQL 目标可核对 [Hyperdrive 查询指标](https://developers.cloudflare.com/hyperdrive/observability/metrics/)是否增长；如果已启用数据库语句统计，也可在 Supabase 核对查询。数据库默认日志不一定逐条记录成功查询。持续观察 Supabase 暂停预警；一次成功查询不构成永不暂停的保证。

以后增删已有绑定对应的目标，只需更新 `SUPABASE_TARGETS` 密钥。增加新的 Hyperdrive 绑定还要更新 `wrangler.toml` 并部署 Worker。

## 停用某个目标

从 `SUPABASE_TARGETS` 里删掉对应条目（`wrangler secret put SUPABASE_TARGETS` 传入更短的数组）。如果该 Hyperdrive 配置不再被其他 Worker 使用，也应从 `wrangler.toml` 移除绑定、重新部署，再在 Cloudflare 删除该 Hyperdrive 配置及其中保存的数据库凭据。删除 Supabase 项目需在其后台单独操作。

## 许可证

[MIT](./LICENSE)。随便用——只要它让你的数据库保持温暖，我们就开心。

## 说明 / 历史

- 最初的 keepalive 逻辑写在一个更大的业务 Worker 里，后来抽成独立的单项目 worker，最终泛化为本仓库这一通用、目标无关的版本。
- 空的 `SUPABASE_TARGETS` 是安全的 no-op（打一条 warning 日志，但不抛错）——所以一次没有配置任何目标的部署不会刷红告警。
