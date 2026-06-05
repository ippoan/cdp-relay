import { describe, it, expect } from "vitest";
import { timingSafeEqual, checkToken } from "../src/lib/auth";
import type { Env } from "../src/env";

describe("timingSafeEqual", () => {
  it("同一文字列で true", async () => {
    expect(await timingSafeEqual("abc123", "abc123")).toBe(true);
  });
  it("1 文字違いで false", async () => {
    expect(await timingSafeEqual("abc123", "abc124")).toBe(false);
  });
  it("長さが違っても false (長さをリークしない)", async () => {
    expect(await timingSafeEqual("abc", "abcdef")).toBe(false);
  });
  it("空文字同士は true", async () => {
    expect(await timingSafeEqual("", "")).toBe(true);
  });
});

describe("checkToken", () => {
  const env = { RELAY_TOKEN: "secret" } as Env;

  it("?token= 一致で ok", async () => {
    expect(await checkToken(new Request("https://x/ext/s?token=secret"), env)).toBe("ok");
  });
  it("Authorization: Bearer 一致で ok", async () => {
    const req = new Request("https://x/mcp", { headers: { Authorization: "Bearer secret" } });
    expect(await checkToken(req, env)).toBe("ok");
  });
  it("query が header より優先される", async () => {
    const req = new Request("https://x/ext/s?token=secret", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(await checkToken(req, env)).toBe("ok");
  });
  it("不一致で bad_token", async () => {
    expect(await checkToken(new Request("https://x/ext/s?token=wrong"), env)).toBe("bad_token");
  });
  it("提示なしで missing_token", async () => {
    expect(await checkToken(new Request("https://x/ext/s"), env)).toBe("missing_token");
  });
  it("RELAY_TOKEN 未設定なら not_configured (fail-closed)", async () => {
    expect(await checkToken(new Request("https://x/ext/s?token=secret"), {} as Env)).toBe("not_configured");
  });
});
