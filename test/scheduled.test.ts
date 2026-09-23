import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { Client } from "pg";
import worker from "../src/index";

const postgres = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock("pg", () => ({ Client: vi.fn(() => postgres) }));

const POSTGRES_URL = "postgresql://postgres.example:secret@pooler.example.com:6543/postgres";

// A SUPABASE_TARGETS value pointing at two fake projects.
const TWO_TARGETS = JSON.stringify([
  { name: "alpha", url: "https://alpha.supabase.co", apiKey: "key-alpha" },
  { name: "beta", url: "https://beta.supabase.co", apiKey: "key-beta" },
]);

const EVENT = {
  cron: "0 9 * * *",
  scheduledTime: 1_700_000_000_000,
  type: "scheduled",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const CTX = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("heartbeat worker — scheduled handler (multi-target)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    postgres.connect.mockResolvedValue(undefined);
    postgres.query.mockResolvedValue({ rows: [{ now: "2026-09-23T00:00:00Z" }] });
    postgres.end.mockResolvedValue(undefined);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("case 1: resolves when all targets return 200", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify("2026-08-17T12:00:00Z"), { status: 200 })
    );

    await expect(
      worker.scheduled(EVENT, { SUPABASE_TARGETS: TWO_TARGETS }, CTX)
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://alpha.supabase.co/rest/v1/rpc/keepalive");
    expect(urls).toContain("https://beta.supabase.co/rest/v1/rpc/keepalive");
  });

  it("case 2: throws an aggregated error naming the failed target (not just 'failed')", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify("2026-08-17T12:00:00Z"), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response('{"message":"internal error"}', { status: 500 })
      );

    const err = await worker
      .scheduled(EVENT, { SUPABASE_TARGETS: TWO_TARGETS }, CTX)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // The failed target must be identifiable in the message.
    expect(String(err)).toMatch(/beta/);
    expect(String(err)).toMatch(/500/);
  });

  it("case 3: one target's network error does not abort the other", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify("2026-08-17T12:00:00Z"), { status: 200 })
      )
      .mockRejectedValueOnce(new Error("ENETUNREACH"));

    const err = await worker
      .scheduled(EVENT, { SUPABASE_TARGETS: TWO_TARGETS }, CTX)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/beta/);
    expect(String(err)).toMatch(/ENETUNREACH/);
    // alpha was still attempted and succeeded before beta failed.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("times out a stalled RPC target and reports the other target's result", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new Error("timed out"))
    );
    fetchSpy.mockImplementationOnce((_url, options) =>
      Promise.reject(options.signal.reason)
    );
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(worker.scheduled(EVENT, { SUPABASE_TARGETS: TWO_TARGETS }, CTX))
      .rejects.toThrow(/alpha\(timed out\)/);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
  });

  it("case 4: empty / missing SUPABASE_TARGETS is a safe no-op (no throw)", async () => {
    await expect(
      worker.scheduled(EVENT, { SUPABASE_TARGETS: "" }, CTX)
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("case 5: invalid JSON in SUPABASE_TARGETS throws clearly", async () => {
    await expect(
      worker.scheduled(EVENT, { SUPABASE_TARGETS: "not-json" }, CTX)
    ).rejects.toThrow(/not valid JSON/);
  });

  it("case 6: a target missing a required field throws clearly", async () => {
    const bad = JSON.stringify([{ name: "alpha", url: "https://a.supabase.co" }]);
    await expect(
      worker.scheduled(EVENT, { SUPABASE_TARGETS: bad }, CTX)
    ).rejects.toThrow(/needs a Supabase url and apiKey/);
  });

  it("case 7 (NFR): does NOT export a fetch handler (no HTTP surface)", () => {
    // Guard: the alarm must not serve HTTP. If someone adds `fetch` later,
    // this test alerts immediately.
    expect(
      (worker as unknown as { fetch?: unknown }).fetch
    ).toBeUndefined();
  });

  it("queries a PostgreSQL target alongside an existing RPC target", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    const targets = JSON.stringify([
      { name: "api", url: "https://api.supabase.co", apiKey: "key" },
      { name: "db", hyperdrive: "DB" },
    ]);

    await expect(worker.scheduled(EVENT, { SUPABASE_TARGETS: targets,
      DB: { connectionString: POSTGRES_URL } }, CTX))
      .resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(Client).toHaveBeenCalledWith(expect.objectContaining({
      connectionString: POSTGRES_URL,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
    }));
    expect(postgres.query).toHaveBeenCalledWith("SELECT now()");
    expect(postgres.end).toHaveBeenCalledOnce();
  });

  it("reports a PostgreSQL failure without logging its password and still pings other targets", async () => {
    fetchSpy.mockResolvedValue(new Response("ok", { status: 200 }));
    postgres.connect.mockRejectedValue(new Error(`failed: ${POSTGRES_URL}`));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const targets = JSON.stringify([
      { name: "api", url: "https://api.supabase.co", apiKey: "key" },
      { name: "db", hyperdrive: "DB" },
    ]);

    const failure = await worker.scheduled(EVENT, { SUPABASE_TARGETS: targets,
      DB: { connectionString: POSTGRES_URL } }, CTX).catch((error) => error);
    expect(String(failure)).toMatch(/db\(PostgreSQL connection or query failed\)/);
    expect(String(failure)).not.toContain("secret");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("secret");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(postgres.end).not.toHaveBeenCalled();
  });

  it("reports a missing Hyperdrive binding without opening a connection", async () => {
    const targets = JSON.stringify([{ name: "db", hyperdrive: "DB" }]);

    await expect(worker.scheduled(EVENT, { SUPABASE_TARGETS: targets }, CTX))
      .rejects.toThrow(/Hyperdrive binding is missing/);
    expect(Client).not.toHaveBeenCalled();
  });

  it("reports a query failure even when closing the connected socket hangs", async () => {
    postgres.query.mockRejectedValue(new Error("query timeout"));
    postgres.end.mockReturnValue(new Promise(() => {}));
    const targets = JSON.stringify([{ name: "db", hyperdrive: "DB" }]);
    const started = Date.now();

    await expect(worker.scheduled(EVENT, { SUPABASE_TARGETS: targets,
      DB: { connectionString: POSTGRES_URL } }, CTX))
      .rejects.toThrow(/db\(PostgreSQL connection or query failed\)/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(postgres.end).toHaveBeenCalledOnce();
  });

  it("rejects mixed target modes and invalid binding names", async () => {
    const mixed = JSON.stringify([{ name: "db", hyperdrive: "DB",
      url: "https://api.supabase.co", apiKey: "key" }]);
    const invalidBinding = JSON.stringify([{ name: "db", hyperdrive: "db-url" }]);

    await expect(worker.scheduled(EVENT, { SUPABASE_TARGETS: mixed }, CTX))
      .rejects.toThrow(/either url \+ apiKey or hyperdrive/);
    await expect(worker.scheduled(EVENT, { SUPABASE_TARGETS: invalidBinding }, CTX))
      .rejects.toThrow(/Hyperdrive binding name/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Client).not.toHaveBeenCalled();
  });
});
