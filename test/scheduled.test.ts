import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import worker from "../src/index";

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
    ).rejects.toThrow(/missing a required field/);
  });

  it("case 7 (NFR): does NOT export a fetch handler (no HTTP surface)", () => {
    // Guard: the alarm must not serve HTTP. If someone adds `fetch` later,
    // this test alerts immediately.
    expect(
      (worker as unknown as { fetch?: unknown }).fetch
    ).toBeUndefined();
  });
});
