import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadDatasetResult } from "../src/data/client";
import { loadObservatoryFeed } from "../src/data/observatory-client";
import {
  OBSERVATORY_FEEDS,
  observatoryManifestSchema,
} from "../src/data/observatory-schemas";
import { sha256Hex } from "../src/lib/sha256";

beforeEach(() => vi.stubGlobal("crypto", undefined));
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
])(
  "matches the SHA-256 known vector %j without Web Crypto",
  (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  },
);

it("hashes non-ASCII UTF-8 and explicit bytes identically without normalizing text", () => {
  const text = "SPOT · 東京 🛰️\n";
  const bytes = Uint8Array.from([
    83, 80, 79, 84, 32, 194, 183, 32, 230, 157, 177, 228, 186, 172, 32, 240,
    159, 155, 176, 239, 184, 143, 10,
  ]);
  const expected =
    "1d96f058a3fa72eb7746d44cdc51537c5eab4f3b36f91270023ccc8885fbe5ee";
  expect(sha256Hex(text)).toBe(expected);
  expect(sha256Hex(bytes)).toBe(expected);
  expect(sha256Hex("é")).not.toBe(sha256Hex("e\u0301"));
  expect(sha256Hex("0x1234")).toBe(
    createHash("sha256").update("0x1234", "utf8").digest("hex"),
  );
  expect(sha256Hex(text.replace("\n", "\r\n"))).not.toBe(expected);
});

function publication() {
  const timestamp = "2026-08-25T12:00:00.000Z";
  const label = "Synthetic UTF-8 evidence · 東京 🛰️";
  const legacyBody = JSON.stringify({ label });
  const feedBody = JSON.stringify({
    schemaVersion: 1,
    feed: "spot-history",
    generatedAt: timestamp,
    chainId: 1,
    source: "ethereum-rpc",
    notes: [label],
    rows: [
      {
        blockNumber: "25841000",
        blockHash: `0x${"1".repeat(64)}`,
        timestamp,
        implementation: {
          address: `0x${"2".repeat(40)}`,
          codeHash: `0x${"3".repeat(64)}`,
        },
        collateralAmpl: "1000000000",
        totalSupply: "1000000000",
        deviationRatio: "100000000",
        deviationRatioDecimals: "8",
        fmvUsd: "1000000000000000000",
        reserveCount: "1",
      },
    ],
  });
  // The reference manifest uses Node's independent SHA implementation.
  const feedHash = createHash("sha256").update(feedBody, "utf8").digest("hex");
  const legacyHash = createHash("sha256")
    .update(legacyBody, "utf8")
    .digest("hex");
  const manifest = observatoryManifestSchema.parse({
    schemaVersion: 1,
    generatedAt: timestamp,
    feeds: {
      ...Object.fromEntries(
        OBSERVATORY_FEEDS.map((feed) => [
          feed,
          {
            status: "unsupported",
            path: null,
            contentHash: null,
            observedAt: null,
            attemptedAt: timestamp,
            message: "no-verified-observations",
            rowCount: 0,
            coverage: null,
          },
        ]),
      ),
      "spot-history": {
        status: "ok",
        path: `/data/observatory/spot-history.${feedHash}.json`,
        contentHash: feedHash,
        observedAt: timestamp,
        attemptedAt: timestamp,
        message: null,
        rowCount: 1,
        coverage: { fromBlock: "25841000", toBlock: "25841000" },
      },
    },
    legacy: {
      "spot-health": {
        path: `/data/observatory/legacy-spot-health.${legacyHash}.json`,
        contentHash: legacyHash,
      },
    },
  });
  const fetcher = (tampered: boolean) => async (path: string) =>
    new Response(
      path.endsWith("observatory-manifest.json")
        ? JSON.stringify(manifest)
        : (path.includes("legacy-spot-health") ? legacyBody : feedBody) +
          (tampered ? "\n" : ""),
    );
  return { label, fetcher };
}

it("loads both legacy and observatory UTF-8 evidence with no crypto global", async () => {
  const { label, fetcher } = publication();
  vi.stubGlobal("fetch", fetcher(false));
  const legacy = await loadDatasetResult(
    "spot-health.json",
    z.object({ label: z.string() }).strict(),
  );
  expect(legacy).toEqual({ data: { label }, sourceFailed: false });
  const feed = await loadObservatoryFeed("spot-history", fetcher(false));
  expect(feed.data?.notes).toEqual([label]);
});

it("rejects changed bytes in both loaders even when the parsed JSON would be identical", async () => {
  const { fetcher } = publication();
  vi.stubGlobal("fetch", fetcher(true));
  await expect(
    loadDatasetResult("spot-health.json", z.object({ label: z.string() })),
  ).rejects.toThrow("does not match its manifest entry");
  await expect(
    loadObservatoryFeed("spot-history", fetcher(true)),
  ).rejects.toThrow("does not match its manifest entry");
});
