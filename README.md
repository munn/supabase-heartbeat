# Supabase Heartbeat

> 🌐 中文文档：[README_zh.md](./README_zh.md) · English below.

A small, generic Cloudflare Worker that keeps **any number of Supabase free-tier
projects** from auto-pausing. Supabase free plans pause a project after 7 days
of inactivity; this worker pings each configured project once a day so they stay
alive — no laptop, no cron job on a person's machine required.

This is a from-scratch, generic rewrite of an older project-specific keepalive
worker that was hard-wired to a single Supabase project. This version is
**target-agnostic**: add a project by adding one line to a config — no code
change, no extra deployment.

## How it works

- One Worker, one daily cron (`0 9 * * *` UTC — inside the 7-day pause window).
- Each invocation reads the `SUPABASE_TARGETS` secret (a JSON array of projects)
  and calls `POST /rest/v1/rpc/keepalive` on every target with its project API
  key (the **anon / publishable** key is recommended — see below).
- `keepalive()` is a trivial SQL function that returns `now()` (see
  `supabase/migrations/0001_keepalive_function.sql`). It touches the DB without
  depending on any table.
- **Failure discipline:** every target is pinged independently. If *any* target
  fails, the worker throws an **aggregated error that names which target(s)
  failed**, so Cloudflare marks the invocation RED and you can tell at a glance
  which project is broken. Failures are never silently swallowed.
- **No `fetch` handler** — the worker is an alarm only, not an HTTP endpoint
  (minimal attack surface).

## Project layout

```
src/index.ts                       # the worker (multi-target scheduled handler)
wrangler.toml                      # name + daily cron + single SUPABASE_TARGETS secret
supabase/migrations/
  0001_keepalive_function.sql      # the keepalive() RPC to apply to each target project
test/scheduled.test.ts             # 7 tests: all-ok / partial-fail / no-op / bad-config / no-fetch
.dev.vars.example                  # local-dev secret template (copy to .dev.vars)
```

## Add a Supabase project to keep alive

You need to do two things per project:

### 1. Install the `keepalive()` RPC on that Supabase project

The worker calls `public.keepalive()`, which must exist on the target project.
Apply `supabase/migrations/0001_keepalive_function.sql` there:

- **SQL Editor:** open the Supabase dashboard → SQL → New query, paste the file,
  run it. (Grants `EXECUTE` on `keepalive()` to both `anon` and `service_role`.)
- **CLI:** `supabase migration new keepalive_function`, paste the body, then
  `supabase db push`.

### 2. Add the project to `SUPABASE_TARGETS`

`SUPABASE_TARGETS` is a JSON array, one entry per project:

```json
[
  { "name": "my-dev",    "url": "https://XXXX.supabase.co", "apiKey": "..." },
  { "name": "client-x",  "url": "https://YYYY.supabase.co", "apiKey": "..." }
]
```

Set it as a secret (preferred for real deploys):

```bash
wrangler secret put SUPABASE_TARGETS
# paste the JSON array when prompted
```

Or for local dev only, copy `.dev.vars.example` → `.dev.vars` and fill it in
(`.dev.vars` is git-ignored — never commit it).

Get the API key from: Supabase dashboard → Project Settings → API.

> **Recommended: use the `anon` / publishable key** (labeled "anon public").
> `keepalive()` only does `SELECT now()` and is granted to `anon`, so the
> low-privilege key is enough — you avoid scattering the `service_role` (god) key
> across every project you keep alive. The `service_role` key works too if you
> prefer or have anon access locked down.

## Deploy (Cloudflare)

```bash
npm install
wrangler secret put SUPABASE_TARGETS      # set your targets (see above)
wrangler deploy                           # single worker, cron is in wrangler.toml
```

Verify:

- `wrangler deployments list` shows the `supabase-heartbeat` script.
- Cloudflare Dashboard → Workers → `supabase-heartbeat` → Triggers shows
  `schedule: 0 9 * * *`.
- After the first natural 09:00 UTC run (or test locally with
  `wrangler dev --test-scheduled` → `curl http://localhost:8787/__scheduled`),
  check each target project's Supabase logs for `POST /rpc/keepalive`.

To change targets later, just `wrangler secret put SUPABASE_TARGETS` again — no
code change, no redeploy needed.

## Decommissioning a target

Remove its entry from `SUPABASE_TARGETS` (`wrangler secret put SUPABASE_TARGETS`
with the shorter array). If you also want to delete the Supabase project itself,
do that separately in the Supabase dashboard.

## License

[MIT](./LICENSE). Do whatever you want — if it keeps your database warm, we're happy.

## Notes / history

- Originally the keepalive logic lived inside a broader business Worker, then was
  extracted to a dedicated single-project worker, and finally generalized into
  this generic, target-agnostic repo.
- Empty `SUPABASE_TARGETS` is a safe no-op (logs a warning, does not throw) — so a
  fresh deploy with no targets configured won't spam RED alerts.
