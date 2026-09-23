import { Client } from "pg";

// Supabase Heartbeat — generic free-tier keepalive worker
//
// Sends a database query to each configured project on every scheduled run.
// Targets with the Data API disabled use a Hyperdrive PostgreSQL binding.
//
// Configuration: a single secret `SUPABASE_TARGETS` — a JSON array of targets:
//   [
//     { "name": "my-dev",  "url": "https://xxxx.supabase.co",            "apiKey": "..." },
//     { "name": "client-x", "hyperdrive": "DB_CLIENT_X" }
//   ]
//
// Failure discipline:
//   - Each target is pinged independently; one failure does NOT abort the others.
//   - If ANY target fails, the handler throws an aggregated error that lists
//     WHICH targets failed, so Cloudflare marks the invocation RED and you can
//     tell at a glance which project is broken. Never silently swallow failures.
//
// No `fetch` handler (the alarm does not serve HTTP — minimal attack surface).

interface RpcTarget {
  name: string;
  // A Supabase project API key. Either the anon (publishable) key or the
  // service_role key works — anon is recommended (keepalive() only does
  // SELECT now() and grants are limited to that function).
  apiKey: string;
  url: string;
}

interface PostgresTarget {
  name: string;
  // Name of a Hyperdrive binding configured in wrangler.toml.
  hyperdrive: string;
}

type Target = RpcTarget | PostgresTarget;

export interface Env {
  SUPABASE_TARGETS: string;
  [binding: string]: unknown;
}

interface TargetResult {
  name: string;
  ok: boolean;
  method?: "RPC" | "PostgreSQL";
  status?: number;
  error?: string;
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const targets = parseTargets(env.SUPABASE_TARGETS);

    if (targets.length === 0) {
      // Nothing configured yet — nothing to keep alive. Log a warning so the
      // silence is visible, but don't throw (this is "nothing to do", not "broken").
      console.warn(
        "[heartbeat] no SUPABASE_TARGETS configured — nothing to keep alive (no-op). " +
          "Set the SUPABASE_TARGETS secret to start pinging projects."
      );
      return;
    }

    const results = await Promise.all(targets.map((target) => pingTarget(target, env)));

    for (const r of results) {
      if (r.ok) {
        console.log(`[heartbeat] OK   ${r.name} (${r.method}${r.status ? ` HTTP ${r.status}` : ""})`);
      } else {
        console.error(
          `[heartbeat] FAIL ${r.name} (${r.status ?? r.error ?? "unknown"})`
        );
      }
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      throw new Error(
        `[heartbeat] ${failed.length}/${results.length} target(s) failed: ` +
          failed.map((f) => `${f.name}(${f.status ?? f.error})`).join(", ")
      );
    }
  },
};

function parseTargets(raw: string | undefined): Target[] {
  if (!raw || raw.trim() === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SUPABASE_TARGETS is not valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("SUPABASE_TARGETS must be a JSON array of targets");
  }

  return parsed.map((t, i): Target => {
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      throw new Error(`SUPABASE_TARGETS[${i}] must be an object`);
    }
    const obj = t as Record<string, unknown>;
    if (typeof obj.name !== "string" || !obj.name.trim()) {
      throw new Error(`SUPABASE_TARGETS[${i}] needs a name`);
    }
    const hasRpc = obj.url !== undefined || obj.apiKey !== undefined;
    const hasPostgres = obj.hyperdrive !== undefined;
    if (hasRpc === hasPostgres) {
      throw new Error(
        `SUPABASE_TARGETS[${i}] needs either url + apiKey or hyperdrive`
      );
    }
    if (hasRpc) {
      if (typeof obj.url !== "string" || !obj.url.startsWith("https://") ||
          typeof obj.apiKey !== "string" || !obj.apiKey) {
        throw new Error(`SUPABASE_TARGETS[${i}] needs a Supabase url and apiKey`);
      }
      return { name: obj.name, url: obj.url, apiKey: obj.apiKey };
    }
    if (typeof obj.hyperdrive !== "string" ||
        !/^[A-Z][A-Z0-9_]*$/.test(obj.hyperdrive)) {
      throw new Error(`SUPABASE_TARGETS[${i}] needs a Hyperdrive binding name`);
    }
    return { name: obj.name, hyperdrive: obj.hyperdrive };
  });
}

async function pingTarget(target: Target, env: Env): Promise<TargetResult> {
  if ("hyperdrive" in target) {
    const binding = env[target.hyperdrive];
    if (!binding || typeof binding !== "object" ||
        !("connectionString" in binding) ||
        typeof binding.connectionString !== "string") {
      return { name: target.name, ok: false, method: "PostgreSQL",
        error: "Hyperdrive binding is missing" };
    }
    return pingPostgres(target.name, binding.connectionString);
  }

  return pingRpc(target);
}

async function pingPostgres(name: string, connectionString: string): Promise<TargetResult> {
  let client: Client | undefined;
  let connected = false;
  try {
    client = new Client({
      connectionString,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
    });
    await client.connect();
    connected = true;
    await client.query("SELECT now()");
    return { name, ok: true, method: "PostgreSQL" };
  } catch {
    // Driver errors may contain database credentials or connection details.
    return { name, ok: false, method: "PostgreSQL", error: "PostgreSQL connection or query failed" };
  } finally {
    if (connected && client) {
      // A broken socket may never finish closing. Bound cleanup so one target
      // cannot prevent the scheduled invocation from reporting all failures.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        client.end().catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }
}

async function pingRpc(target: RpcTarget): Promise<TargetResult> {
  const baseUrl = target.url.replace(/\/$/, "");
  const url = `${baseUrl}/rest/v1/rpc/keepalive`;

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        apikey: target.apiKey,
        Authorization: `Bearer ${target.apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (!res.ok) {
      // .catch guards against res.text() itself failing (body closed early, etc.)
      // Truncate to 200 chars to avoid log pollution. Supabase responses normally
      // don't contain the apikey/Authorization, so this is safe to log.
      const body = await res.text().catch(() => "");
      return {
        name: target.name,
        ok: false,
        method: "RPC",
        status: res.status,
        error: body.slice(0, 200),
      };
    }

    return { name: target.name, ok: true, method: "RPC", status: res.status };
  } catch (err) {
    return {
      name: target.name,
      ok: false,
      method: "RPC",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
