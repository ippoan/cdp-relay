import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

const BASE = "https://cdp-relay.test";
const TOKEN = "test-token"; // vitest.config.ts の RELAY_TOKEN と一致

/** WS upgrade して accept 済みソケットを返す。101 以外は例外。 */
async function openWs(path: string): Promise<WebSocket> {
  const res = await SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: "websocket" } });
  if (res.status !== 101) throw new Error(`expected 101, got ${res.status}`);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

/** 次の message フレーム (文字列) を待つ。 */
function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (e: MessageEvent) => resolve(typeof e.data === "string" ? e.data : ""),
      { once: true },
    );
  });
}

describe("raw CDP passthrough (chrome-devtools-mcp)", () => {
  it("bridge 脚は token 無しで 401", async () => {
    const res = await SELF.fetch(`${BASE}/cdpbridge/s1`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("bridge 脚は token 不正で 401", async () => {
    const res = await SELF.fetch(`${BASE}/cdpbridge/s1?token=wrong`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("bridge 脚は Upgrade 無しで 426", async () => {
    const res = await SELF.fetch(`${BASE}/cdpbridge/s1?token=${TOKEN}`);
    expect(res.status).toBe(426);
  });

  it("client 脚は bridge 未接続だと 503 (fail-fast)", async () => {
    const session = "cdp-" + crypto.randomUUID();
    const res = await SELF.fetch(`${BASE}/cdp/${session}/devtools/browser?token=${TOKEN}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("cdp_bridge_not_connected");
  });

  it("client 脚も token 必須 (401)", async () => {
    const session = "cdp-" + crypto.randomUUID();
    const res = await SELF.fetch(`${BASE}/cdp/${session}/devtools/browser`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("bridge 接続後は client 脚が 101 で合流できる", async () => {
    const session = "cdp-" + crypto.randomUUID();
    const bridge = await openWs(`/cdpbridge/${session}?token=${TOKEN}`);
    const client = await openWs(`/cdp/${session}/devtools/browser?token=${TOKEN}`);
    bridge.close();
    client.close();
  });

  it("client → bridge にフレームが無加工転送される", async () => {
    const session = "cdp-" + crypto.randomUUID();
    const bridge = await openWs(`/cdpbridge/${session}?token=${TOKEN}`);
    const client = await openWs(`/cdp/${session}/devtools/browser?token=${TOKEN}`);

    const onBridge = nextMessage(bridge);
    const frame = JSON.stringify({ id: 1, method: "Target.setDiscoverTargets", params: { discover: true } });
    client.send(frame);
    expect(await onBridge).toBe(frame);

    bridge.close();
    client.close();
  });

  it("bridge → client にフレームが無加工転送される", async () => {
    const session = "cdp-" + crypto.randomUUID();
    const bridge = await openWs(`/cdpbridge/${session}?token=${TOKEN}`);
    const client = await openWs(`/cdp/${session}/devtools/browser?token=${TOKEN}`);

    const onClient = nextMessage(client);
    const frame = JSON.stringify({ id: 1, result: { targetInfos: [] } });
    bridge.send(frame);
    expect(await onClient).toBe(frame);

    bridge.close();
    client.close();
  });

  it("bridge が閉じると client 脚も切断される (peer teardown)", async () => {
    const session = "cdp-" + crypto.randomUUID();
    const bridge = await openWs(`/cdpbridge/${session}?token=${TOKEN}`);
    const client = await openWs(`/cdp/${session}/devtools/browser?token=${TOKEN}`);

    const clientClosed = new Promise<number>((resolve) => {
      client.addEventListener("close", (e: CloseEvent) => resolve(e.code), { once: true });
    });
    bridge.close(1000, "bye");
    // teardownCdpPeer が client を 1001 で畳む。
    expect(await clientClosed).toBe(1001);
  });
});
