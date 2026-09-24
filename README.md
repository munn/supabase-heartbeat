# Supabase Heartbeat

> 🌐 中文文档：[README_zh.md](./README_zh.md) · English below.

A small Cloudflare Worker that periodically queries multiple Supabase Free Plan
projects to reduce the chance of an inactivity pause. It supports an RPC over
the Data API or a PostgreSQL connection for projects with the Data API disabled.
No laptop or local cron job is needed.

This is a from-scratch, generic rewrite of an older project-specific keepalive
worker that was hard-wired to a single Supabase project. This version is
**target-agnostic**: RPC targets need only a secret update; projects with the
Data API disabled also need a Hyperdrive configuration and binding.

## How it works

- One Worker runs three times a day (01:00, 09:00, and 17:00 UTC). [Supabase says](https://supabase.com/docs/guides/platform/free-project-pausing)
  a few user database requests each day are typically enough, but does not
  guarantee that any fixed schedule will prevent pausing.
- Each invocation reads the `SUPABASE_TARGETS` secret (a JSON array). Each target
  either calls `POST /rest/v1/rpc/keepalive` or connects to PostgreSQL through
  Cloudflare Hyperdrive and runs `SELECT now()`.
- RPC targets need the `keepalive()` SQL function; PostgreSQL targets need no
  custom function or table.
- **Failure discipline:** every target is pinged independently. If *any* target
  fails, the worker throws an **aggregated error that names which target(s)
  failed**, so Cloudflare marks the invocation RED and you can tell at a glance
  which project is broken. Failures are never silently swallowed.
- **No `fetch` handler** — the worker is an alarm only, not an HTTP endpoint
  (minimal attack surface).

## Verified production status (2026-09-24)

One production Worker now queries two projects: an RPC target with the Data API enabled and a PostgreSQL/Hyperdrive target with it disabled. Cloudflare recorded the first scheduled Cron as successful at 01:01 UTC on 2026-09-24. Both paths logged `OK` in the same invocation, with HTTP 200 for the RPC. The dedicated PostgreSQL role's `SELECT now()` call count increased by one after that run. Both paths had also succeeded in an immediate Cloudflare remote preview.

The repository's `wrangler.toml` is a generic template and **does not contain the production Hyperdrive ID or database credentials**. To reproduce a Data API-disabled deployment, first put the real binding and ID in a Git-ignored copy of the configuration and deploy with that configuration. The template deploy command below alone will not include the production Hyperdrive binding. One successful run does not guarantee that Supabase will never pause a project.

## Project layout

```
src/index.ts                       # the worker (multi-target scheduled handler)
wrangler.toml                      # name + scheduled cron + Hyperdrive binding examples
supabase/migrations/
  0001_keepalive_function.sql      # install only for RPC targets
test/scheduled.test.ts             # scheduler, both connection modes, and invalid config
.dev.vars.example                  # local-dev secret template (copy to .dev.vars)
```

## Add a Supabase project to keep alive

Choose the method according to whether the project has the Data API enabled.

### Data API enabled: RPC

The worker calls `public.keepalive()`, which must exist on the target project.
Apply `supabase/migrations/0001_keepalive_function.sql` there:

- **SQL Editor:** open the Supabase dashboard → SQL → New query, paste the file,
  run it. (Grants `EXECUTE` on `keepalive()` to both `anon` and `service_role`.)
- **CLI:** `supabase migration new keepalive_function`, paste the body, then
  `supabase db push`.

### Data API disabled: PostgreSQL

1. In the Supabase Dashboard, open **Connect → Session pooler** and copy its
   port **5432** connection string. Replace `[YOUR-PASSWORD]`, URL-encoding
   reserved characters in the password. Free Plan direct connections are usually
   IPv6-only, and this project has not verified Hyperdrive connectivity to an
   IPv6-only origin, so the IPv4 Session pooler is the default. Do not use the
   port 6543 Transaction pooler or construct the pooler hostname yourself.
   [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres)
2. Create a **Hyperdrive** configuration in the Cloudflare Dashboard with that
   connection string. **Disable query caching** so each scheduled call reaches
   the database. Keep the database password in Hyperdrive, not in
   `SUPABASE_TARGETS` or this repository. [Hyperdrive caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
3. Download the project's CA certificate from Supabase Dashboard → Database
   Settings → SSL Configuration, upload it to Cloudflare, and select
   **verify-full** with that CA in Hyperdrive. Confirm the certificate covers
   the Session pooler hostname. Do not disable certificate verification.
   [Supabase SSL](https://supabase.com/docs/guides/platform/ssl-enforcement) ·
   [Hyperdrive TLS](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
4. Add a `[[hyperdrive]]` entry to `wrangler.toml` with a binding such as
   `DB_CLIENT_X` (this Worker requires an uppercase first letter, followed by
   uppercase letters, digits, or underscores) and the new Hyperdrive
   configuration ID, then deploy the updated
   Worker. Each Data API-disabled project needs its own cache-disabled Hyperdrive
   configuration and binding; no custom SQL function is required.

### Add the project to `SUPABASE_TARGETS`

`SUPABASE_TARGETS` is a JSON array, one entry per project:

```json
[
  { "name": "my-dev",    "url": "https://XXXX.supabase.co", "apiKey": "..." },
  { "name": "client-x",  "hyperdrive": "DB_CLIENT_X" }
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

> **For RPC targets, prefer the `anon` / publishable key** (labeled "anon public").
> Hyperdrive stores database credentials for PostgreSQL targets; an `apiKey`
> cannot replace the database password. Do not mix both configuration methods
> in one target.

## Deploy (Cloudflare)

```bash
npm install
wrangler deploy                           # template is for RPC-only targets
wrangler secret put SUPABASE_TARGETS      # set targets after deploying
```

For a PostgreSQL target, point both Wrangler commands at the same private configuration containing the real Hyperdrive binding (using `--config`). Do not deploy the repository template directly. Keep that configuration in a Git-ignored directory and verify it with `git check-ignore`; if it lives outside the repository root, adjust `main` relative to its location and preserve the Cron trigger and Workers Logs settings.

Verify:

- `wrangler deployments list` shows the `supabase-heartbeat` script.
- Cloudflare Dashboard → Workers → `supabase-heartbeat` → Triggers shows
  `schedule: 0 1,9,17 * * *`.
- After the first run, check that Worker logs show each target as `OK`. For RPC
  targets, check Supabase API logs for `/rpc/keepalive`. For PostgreSQL targets,
  check whether [Hyperdrive query metrics](https://developers.cloudflare.com/hyperdrive/observability/metrics/)
  increase; if statement statistics are enabled, you can also check them in
  Supabase. Successful queries may not appear individually in default database
  logs. Continue watching for Supabase pause warnings: one successful query is
  not a guarantee against pausing.

To add or remove targets whose bindings already exist, update the
`SUPABASE_TARGETS` secret. A new Hyperdrive binding also requires a
`wrangler.toml` update and Worker deployment.

## Decommissioning a target

Remove its entry from `SUPABASE_TARGETS` (`wrangler secret put SUPABASE_TARGETS`
with the shorter array). If no other Worker uses its Hyperdrive configuration,
remove the binding from `wrangler.toml`, redeploy, then delete the Hyperdrive
configuration and its stored database credentials in Cloudflare. Delete the
Supabase project separately in its dashboard if needed.

## License

[MIT](./LICENSE). Do whatever you want — if it keeps your database warm, we're happy.

## Notes / history

- Originally the keepalive logic lived inside a broader business Worker, then was
  extracted to a dedicated single-project worker, and finally generalized into
  this generic, target-agnostic repo.
- Empty `SUPABASE_TARGETS` is a safe no-op (logs a warning, does not throw) — so a
  fresh deploy with no targets configured won't spam RED alerts.
