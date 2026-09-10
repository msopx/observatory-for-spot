import { webcrypto } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJsonBytes, hashScenarioId } from "../src/reports/report";
import { hashScenarioIdNode } from "../src/reports/node-hash";
import { recordedQuotesFixture } from "./fixtures/recorded-quotes";

afterEach(() => vi.unstubAllGlobals());

describe("scenario hashing without secure-context Web Crypto", () => {
  it("preserves canonical UTF-8 IDs with no global crypto", async () => {
    vi.stubGlobal("crypto", undefined);
    for (const scenario of [
      // Recorded quotes are strings, booleans and nulls: canonical without numbers.
      recordedQuotesFixture().grid.spotToUsd,
      { z: ["SPOT → USDC", "日本語", "line\nfeed"], a: 9007199254740993n },
      { text: "0x1234", empty: "", unpairedSurrogate: "\ud800" },
    ]) {
      await expect(hashScenarioId(scenario)).resolves.toBe(
        hashScenarioIdNode(scenario),
      );
    }
    await expect(hashScenarioId({ z: "2", a: "1" })).resolves.toBe(
      await hashScenarioId({ a: "1", z: "2" }),
    );
  });

  it("honors an explicit provider with the exact canonical bytes", async () => {
    vi.stubGlobal("crypto", undefined);
    const scenario = { z: "日本語", a: 42n };
    const digest = vi.fn(async () => new Uint8Array(32).fill(0xab).buffer);
    const provider = { subtle: { digest } } as unknown as Pick<
      Crypto,
      "subtle"
    >;
    await expect(hashScenarioId(scenario, provider)).resolves.toBe(
      `sha256:${"ab".repeat(32)}`,
    );
    const call = digest.mock.calls[0] as unknown as [string, ArrayBuffer];
    expect(call[0]).toBe("SHA-256");
    expect(new Uint8Array(call[1])).toEqual(canonicalJsonBytes(scenario));
  });

  it("agrees with an explicitly injected real Web Crypto provider", async () => {
    const scenario = { amount: 12345678901234567890n, symbol: "SPOT" };
    const provider = webcrypto as unknown as Pick<Crypto, "subtle">;
    await expect(hashScenarioId(scenario, provider)).resolves.toBe(
      await hashScenarioId(scenario),
    );
  });

  it("does not silently bypass an explicit missing or failed provider", async () => {
    const missing = {} as Pick<Crypto, "subtle">;
    await expect(hashScenarioId({ amount: "1" }, missing)).rejects.toThrow(
      "Web Crypto subtle.digest is unavailable",
    );
    const failure = new Error("injected digest failed");
    const provider = {
      subtle: { digest: vi.fn().mockRejectedValue(failure) },
    } as unknown as Pick<Crypto, "subtle">;
    await expect(hashScenarioId({ amount: "1" }, provider)).rejects.toBe(
      failure,
    );
  });

  it("still rejects noncanonical financial number values", async () => {
    vi.stubGlobal("crypto", undefined);
    await expect(hashScenarioId({ amount: 1 })).rejects.toThrow(
      "number values are forbidden",
    );
  });
});
