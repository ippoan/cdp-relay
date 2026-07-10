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

describe("MCP passthrough (mcpbridge / mcppipe)", () => {
  it("bridge 脚は token 無しで 401", async () => {
    const res = await SELF.fetch(`${BASE}/mcpbridge/s1`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("bridge 脚は token 不正で 401", async () => {
    const res = await SELF.fetch(`${BASE}/mcpbridge/s1?token=wrong`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("bridge 脚は Upgrade 無しで 426", async () => {
    const res = await SELF.fetch(`${BASE}/mcpbridge/s1?token=${TOKEN}`);
    expect(res.status).toBe(426);
  });

  it("client 脚は bridge 未接続だと 503 (fail-fast)", async () => {
    const session = "mcp-" + crypto.randomUUID();
    const res = await SELF.fetch(`${BASE}/mcppipe/${session}?token=${TOKEN}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("mcp_bridge_not_connected");
  });

  it("client 脚も token 必須 (401)", async () => {
    const session = "mcp-" + crypto.randomUUID();
    const res = await SELF.fetch(`${BASE}/mcppipe/${session}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("bridge 接続後は client 脚が 101 で合流し、双方向にフレームが無加工転送される", async () => {
    const session = "mcp-" + crypto.randomUUID();
    const bridge = await openWs(`/mcpbridge/${session}?token=${TOKEN}`);
    const client = await openWs(`/mcppipe/${session}?token=${TOKEN}`);

    // client (MCP initialize) → bridge
    const onBridge = nextMessage(bridge);
    const initFrame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    client.send(initFrame);
    expect(await onBridge).toBe(initFrame);

    // bridge (initialize result) → client
    const onClient = nextMessage(client);
    const resultFrame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "chrome_devtools" } } });
    bridge.send(resultFrame);
    expect(await onClient).toBe(resultFrame);

    bridge.close();
    client.close();
  });

  it('keepalive "ping" は相手脚へ転送されない (握り潰し)', async () => {
    const session = "mcp-" + crypto.randomUUID();
    const bridge = await openWs(`/mcpbridge/${session}?token=${TOKEN}`);
    const client = await openWs(`/mcppipe/${session}?token=${TOKEN}`);

    const onClient = nextMessage(client);
    bridge.send("ping");
    const real = JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} });
    bridge.send(real);
    expect(await onClient).toBe(real);

    bridge.close();
    client.close();
  });

  it("bridge が閉じると client 脚も切断される (peer teardown)", async () => {
    const session = "mcp-" + crypto.randomUUID();
    const bridge = await openWs(`/mcpbridge/${session}?token=${TOKEN}`);
    const client = await openWs(`/mcppipe/${session}?token=${TOKEN}`);

    const clientClosed = new Promise<number>((resolve) => {
      client.addEventListener("close", (e: CloseEvent) => resolve(e.code), { once: true });
    });
    bridge.close(1000, "bye");
    expect(await clientClosed).toBe(1001);
  });

  it("client が閉じると bridge 脚も切断される (child respawn の契機)", async () => {
    const session = "mcp-" + crypto.randomUUID();
    const bridge = await openWs(`/mcpbridge/${session}?token=${TOKEN}`);
    const client = await openWs(`/mcppipe/${session}?token=${TOKEN}`);

    const bridgeClosed = new Promise<number>((resolve) => {
      bridge.addEventListener("close", (e: CloseEvent) => resolve(e.code), { once: true });
    });
    client.close(1000, "bye");
    expect(await bridgeClosed).toBe(1001);
  });

  it("mcp 脚と cdp 脚は同 session でも混線しない", async () => {
    const session = "mixed-" + crypto.randomUUID();
    const mcpBridge = await openWs(`/mcpbridge/${session}?token=${TOKEN}`);
    const cdpBridge = await openWs(`/cdpbridge/${session}?token=${TOKEN}`);
    const mcpClient = await openWs(`/mcppipe/${session}?token=${TOKEN}`);
    const cdpClient = await openWs(`/cdp/${session}/devtools/browser?token=${TOKEN}`);

    // mcp client のフレームは mcp bridge にだけ届く。
    const onMcpBridge = nextMessage(mcpBridge);
    let cdpGot = "";
    cdpBridge.addEventListener("message", (e: MessageEvent) => {
      cdpGot = typeof e.data === "string" ? e.data : "?";
    });
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    mcpClient.send(frame);
    expect(await onMcpBridge).toBe(frame);
    expect(cdpGot).toBe("");

    mcpBridge.close();
    cdpBridge.close();
    mcpClient.close();
    cdpClient.close();
  });
});
