import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { browserPair } from "../src/mcp/tools";
import type { Env } from "../src/env";

// rendezvous (cdp-relay#12 M3): 手元 agent が quick tunnel URL を /register で登録し、
// CCoW proxy が /lookup で引く。tunnel_url は capability なので /ext と同じ
// relay-token / pairing code 認証を要求する (= 「最初だけ DO、あと手元」の出会いの場)。
const E = env as unknown as Env;
const BASE = "https://cdp-relay.test";

const TUNNEL = "https://elephant-platform-predicted-catalog.trycloudflare.com";

async function register(session: string, token: string, tunnelUrl: string): Promise<Response> {
  return SELF.fetch(`${BASE}/register/${session}?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tunnel_url: tunnelUrl }),
  });
}

describe("rendezvous (/register + /lookup)", () => {
  it("register した tunnel_url を同 session の lookup で引ける", async () => {
    const session = "rdv-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, session);

    const reg = await register(session, pair_code, TUNNEL);
    expect(reg.status).toBe(200);
    const regBody = (await reg.json()) as { ok: boolean; tunnel_url: string };
    expect(regBody.ok).toBe(true);
    expect(regBody.tunnel_url).toBe(TUNNEL);

    const look = await SELF.fetch(`${BASE}/lookup/${session}?token=${pair_code}`);
    expect(look.status).toBe(200);
    const body = (await look.json()) as { tunnel_url: string; updated_at: number };
    expect(body.tunnel_url).toBe(TUNNEL);
    expect(body.updated_at).toBeGreaterThan(0);
  });

  it("再 register で tunnel_url が上書きされる (single row)", async () => {
    const session = "rdvup-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, session);
    await register(session, pair_code, TUNNEL);
    const next = "https://second-tunnel-xyz.trycloudflare.com";
    await register(session, pair_code, next);

    const look = await SELF.fetch(`${BASE}/lookup/${session}?token=${pair_code}`);
    const body = (await look.json()) as { tunnel_url: string };
    expect(body.tunnel_url).toBe(next);
  });

  it("未登録 session の lookup は 404", async () => {
    const session = "rdvnone-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, session);
    const look = await SELF.fetch(`${BASE}/lookup/${session}?token=${pair_code}`);
    expect(look.status).toBe(404);
    const body = (await look.json()) as { error: string };
    expect(body.error).toBe("not_registered");
  });

  it("非 https な tunnel_url は 400", async () => {
    const session = "rdvbad-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, session);
    const reg = await register(session, pair_code, "http://insecure.example.com");
    expect(reg.status).toBe(400);
  });

  it("pairing code 無し (でたらめ) の register / lookup は 401", async () => {
    const session = "rdvauth-" + crypto.randomUUID();
    await browserPair(E, session);
    const reg = await register(session, "deadbeef", TUNNEL);
    expect(reg.status).toBe(401);
    const look = await SELF.fetch(`${BASE}/lookup/${session}?token=deadbeef`);
    expect(look.status).toBe(401);
  });

  it("別 session の pairing code では弾く (401) — tunnel_url は session スコープ", async () => {
    const minted = "rdvA-" + crypto.randomUUID();
    const other = "rdvB-" + crypto.randomUUID();
    const { pair_code } = await browserPair(E, minted);
    const reg = await register(other, pair_code, TUNNEL);
    expect(reg.status).toBe(401);
  });
});
