// Supabase Heartbeat — generic free-tier keepalive worker
//
// Keeps ANY number of Supabase projects alive by calling each one's
// `public.keepalive()` RPC once per scheduled invocation. This prevents the
// Supabase free-plan 7-day auto-pause for every configured project — useful
// for dev sandboxes, standby projects, or anything that sits idle but must
// not be recycled.
//
// Configuration: a single secret `SUPABASE_TARGETS` — a JSON array of targets:
//   [
//     { "name": "my-dev",  "url": "https://xxxx.supabase.co",            "apiKey": "..." },
//     { "name": "client-x", "url": "https://yyyy.supabase.co",           "apiKey": "..." }
//   ]
//
// Failure discipline:
//   - Each target is pinged independently; one failure does NOT abort the others.
//   - If ANY target fails, the handler throws an aggregated error that lists
//     WHICH targets failed, so Cloudflare marks the invocation RED and you can
//     tell at a glance which project is broken. Never silently swallow failures.
//
// No `fetch` handler (the alarm does not serve HTTP — minimal attack surface).

interface Target {
  name: string;
  url: string;
  // A Supabase project API key. Either the anon (publishable) key or the
  // service_role key works — anon is recommended (keepalive() only does
  // SELECT now() and grants are limited to that function).
  apiKey: string;
}

export interface Env {
  SUPABASE_TARGETS: string;
}

interface TargetResult {
  name: string;
  ok: boolean;
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

    const results = await Promise.all(targets.map(pingTarget));

    for (const r of results) {
      if (r.ok) {
        console.log(`[heartbeat] OK   ${r.name} (HTTP ${r.status})`);
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

  return parsed.map((t, i) => {
    const obj = t as Partial<Target>;
    if (!obj.name || !obj.url || !obj.apiKey) {
      throw new Error(
        `SUPABASE_TARGETS[${i}] missing a required field ` +
          `(need name, url, apiKey)`
      );
    }
    return {
      name: obj.name,
      url: obj.url,
      apiKey: obj.apiKey,
    };
  });
}

async function pingTarget(target: Target): Promise<TargetResult> {
  const baseUrl = target.url.replace(/\/$/, "");
  const url = `${baseUrl}/rest/v1/rpc/keepalive`;

  try {
    const res = await fetch(url, {
      method: "POST",
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
        status: res.status,
        error: body.slice(0, 200),
      };
    }

    return { name: target.name, ok: true, status: res.status };
  } catch (err) {
    return {
      name: target.name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
