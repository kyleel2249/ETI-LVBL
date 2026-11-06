// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hmacSha256Hex, signBinanceQuery } from "./sign";

describe("signing", () => {
  it("matches the official Binance documentation HMAC vector", async () => {
    const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const msg =
      "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(await hmacSha256Hex(secret, msg)).toBe(
      "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71",
    );
  });
  it("appends timestamp, recvWindow and signature, skipping undefined", async () => {
    const q = await signBinanceQuery({ symbol: "BTCUSDT", x: undefined }, "s", 1000, 5000);
    expect(q).toMatch(/^symbol=BTCUSDT&recvWindow=5000&timestamp=1000&signature=[0-9a-f]{64}$/);
  });
});
