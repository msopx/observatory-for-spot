import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  main as refreshCommand,
  observatoryOutputDirectory,
} from "../scripts/refresh-observatory";

import { CONTRACTS } from "../src/data/contracts";
import {
  feedFreshness,
  loadObservatoryFeed,
} from "../src/data/observatory-client";
import {
  publishObservatoryRefresh,
  readObservatoryManifest,
  readPublishedFeed,
} from "../src/data/observatory-files";
import {
  buildBrokerLedger,
  type BrokerAssetTransfer,
} from "../src/data/observatory-ledger";

import {
  mergeAmplHistoryBaseline,
  readAmplHistoryIncremental,
} from "../src/data/observatory-refresh";
import {
  holdingPeriodPercent,
  observatoryDatasetSchema,
  type BrokerHistoryEvent,
  type ObservatoryDatasetFor,
} from "../src/data/observatory-schemas";
import { amplRebasesDatasetSchema } from "../src/data/schemas";
import type {
  ObservatoryPublicClient,
  ResolvedReleaseBlock,
} from "../src/data/refresh";

const directories: string[] = [];
const HASH = `0x${"11".repeat(32)}` as const;
const TX = `0x${"22".repeat(32)}` as const;
const ADDRESS = `0x${"33".repeat(20)}` as const;
const OBSERVED = "2026-08-28T12:45:11.000Z";
const ATTEMPT = "2026-09-06T03:00:00.000Z";
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "observatory-refresh-"));
  directories.push(directory);
  return directory;
}

function spotFeed(timestamp = OBSERVED): ObservatoryDatasetFor<"spot-history"> {
  return observatoryDatasetSchema.parse({
    schemaVersion: 1,
    feed: "spot-history",
    generatedAt: ATTEMPT,
    chainId: 1,
    source: "ethereum-rpc",
    notes: [],
    rows: [
      {
        blockNumber: "25853823",
        blockHash: HASH,
        timestamp,
        implementation: { address: ADDRESS, codeHash: HASH },
        collateralAmpl: "1000000000",
        totalSupply: "2000000000",
        deviationRatio: "100000000",
        deviationRatioDecimals: "8",
        fmvUsd: "1000000000000000000",
        reserveCount: "1",
      },
    ],
  }) as ObservatoryDatasetFor<"spot-history">;
}

function marketFeed(): ObservatoryDatasetFor<"spot-market"> {
  return observatoryDatasetSchema.parse({
    schemaVersion: 2,
    feed: "spot-market",
    generatedAt: ATTEMPT,
    chainId: 1,
    source: "ethereum-rpc",
    notes: [],
    pool: {
      address: "0x898aDC9aa0C23DCE3fED6456C34DbE2b57784325",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      token0: CONTRACTS.usdc.address,
      token1: CONTRACTS.spot.address,
      baseToken: {
        address: CONTRACTS.spot.address,
        name: null,
        symbol: "SPOT",
        decimals: "9",
      },
      quoteToken: {
        address: CONTRACTS.usdc.address,
        name: null,
        symbol: "USDC",
        decimals: "6",
      },
      fee: "10000",
      tickSpacing: "200",
      codeHash: HASH,
      verifiedAt: {
        blockNumber: "25853823",
        blockHash: HASH,
        timestamp: ATTEMPT,
      },
    },
    rows: [
      {
        periodStart: "2026-09-04T00:00:00.000Z",
        timestamp: "2026-09-05T00:00:00.000Z",
        fromBlock: "25853803",
        toBlock: "25853812",
      },
      {
        periodStart: "2026-09-05T00:00:00.000Z",
        timestamp: "2026-09-06T00:00:00.000Z",
        fromBlock: "25853813",
        toBlock: "25853822",
      },
    ].map((row) => ({
      ...row,
      toBlockHash: HASH,
      swapCount: "0",
      volumeQuote: "0",
      priceQuote: null,
      lastSwap: null,
    })),
  }) as ObservatoryDatasetFor<"spot-market">;
}

describe("independent feed publication", () => {
  it("retains the last valid payload and observation date after a failed refresh", async () => {
    const directory = await temporaryDirectory();
    const initial = await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-history", dataset: spotFeed() },
    ]);
    const failed = await publishObservatoryRefresh(
      directory,
      "2026-09-06T04:00:00.000Z",
      [
        { feed: "spot-history", failure: "read-failed" },
        {
          feed: "exit-inputs",
          status: "unsupported",
          failure: "implementation-unsupported",
        },
      ],
    );
    expect(failed.feeds["spot-history"]).toMatchObject({
      status: "error",
      path: initial.feeds["spot-history"].path,
      contentHash: initial.feeds["spot-history"].contentHash,
      observedAt: OBSERVED,
      attemptedAt: "2026-09-06T04:00:00.000Z",
    });
    expect(failed.feeds["exit-inputs"]).toMatchObject({
      status: "unsupported",
      path: null,
      rowCount: 0,
    });
    expect(
      await readPublishedFeed(directory, failed.feeds["spot-history"]),
    ).toEqual(spotFeed());
    expect(
      feedFreshness(failed.feeds["spot-history"], new Date(ATTEMPT)),
    ).toMatchObject({ stale: true, retained: true });
  });

  it("never publishes a partially staged or backward-moving batch", async () => {
    const directory = await temporaryDirectory();
    await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-history", dataset: spotFeed() },
    ]);
    const oldManifest = await readFile(
      join(directory, "observatory-manifest.json"),
      "utf8",
    );
    const backward = await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-history", dataset: spotFeed("2026-08-27T12:45:11.000Z") },
    ]);
    expect(backward.feeds["spot-history"]).toMatchObject({
      observedAt: OBSERVED,
      status: "error",
      message: "history-incomplete",
    });
    const retainedManifest = await readFile(
      join(directory, "observatory-manifest.json"),
      "utf8",
    );
    expect(backward.feeds["spot-history"].path).toBe(
      JSON.parse(oldManifest).feeds["spot-history"].path,
    );
    await expect(
      publishObservatoryRefresh(directory, ATTEMPT, [
        { feed: "spot-history", dataset: spotFeed() },
        { feed: "spot-history", failure: "read-failed" },
      ]),
    ).rejects.toThrow("Duplicate");
    expect(
      await readFile(join(directory, "observatory-manifest.json"), "utf8"),
    ).toBe(retainedManifest);
  });

  it("validates content hashes at the writer and browser boundary", async () => {
    const directory = await temporaryDirectory();
    const manifest = await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-history", dataset: spotFeed() },
    ]);
    const fetcher = async (url: string) => {
      const file = url.endsWith("observatory-manifest.json")
        ? join(directory, "observatory-manifest.json")
        : join(directory, "observatory", basename(url));
      return new Response(await readFile(file, "utf8"));
    };
    const loaded = await loadObservatoryFeed("spot-history", fetcher);
    expect(loaded.data?.rows[0]?.collateralAmpl).toBe("1000000000");
    const path = join(
      directory,
      "observatory",
      basename(manifest.feeds["spot-history"].path!),
    );
    await writeFile(path, "{}\n", "utf8");
    await expect(loadObservatoryFeed("spot-history", fetcher)).rejects.toThrow(
      "does not match its manifest entry",
    );
    await expect(
      readPublishedFeed(directory, manifest.feeds["spot-history"]),
    ).rejects.toThrow("integrity");
  });

  it("does not falsely refresh feeds that were not attempted", async () => {
    const directory = await temporaryDirectory();
    const first = await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-history", dataset: spotFeed() },
    ]);
    const second = await publishObservatoryRefresh(
      directory,
      "2026-09-07T00:00:00.000Z",
      [{ feed: "spot-market", failure: "market-source-unavailable" }],
    );
    expect(second.feeds["spot-history"]).toEqual(first.feeds["spot-history"]);
    expect(await readObservatoryManifest(directory)).toEqual(second);
  });

  it("preserves newer legacy snapshots when an older concurrent refresh finishes later", async () => {
    const directory = await temporaryDirectory();
    const baseline = JSON.parse(
      await readFile("public/data/spot-health.json", "utf8"),
    );
    const initial = await publishObservatoryRefresh(directory, ATTEMPT, [], {
      "spot-health": baseline,
    });
    const earlier = {
      ...baseline,
      metadata: {
        ...baseline.metadata,
        blockNumber: (BigInt(baseline.metadata.blockNumber) - 1n).toString(),
      },
    };
    const result = await publishObservatoryRefresh(
      directory,
      "2026-09-06T02:00:00.000Z",
      [],
      { "spot-health": earlier },
    );
    expect(result.legacy?.["spot-health"]).toEqual(
      initial.legacy?.["spot-health"],
    );
    expect(result.generatedAt).toBe(ATTEMPT);
  });
});

describe("CLI and worker source failures", () => {
  async function setup(feeds?: string) {
    const directory = await temporaryDirectory();
    const first = await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-history", dataset: spotFeed() },
    ]);
    vi.stubEnv("OBSERVATORY_DATA_DIRECTORY", directory);
    vi.stubEnv("ETHEREUM_RPC_URL", "https://rpc.example.invalid");
    vi.stubEnv("AMPL_LOG_RPC_URL", "");
    vi.stubEnv("RELEASE_BLOCK", "25853823");
    vi.stubEnv("RELEASE_BLOCK_HASH", HASH);
    vi.stubEnv("OBSERVATORY_HISTORY_DAYS", "90");
    vi.stubEnv("OBSERVATORY_SAMPLE_INTERVAL_DAYS", "7");
    vi.stubEnv("OBSERVATORY_FEEDS", feeds ?? "");
    return { directory, first };
  }
  const attemptedAt = "2026-09-06T04:00:00.000Z";
  const now = () => new Date(attemptedAt);
  function marketClient() {
    const block = {
      number: 25_853_823n,
      hash: HASH,
      timestamp: BigInt(Date.parse(ATTEMPT) / 1000),
    };
    return {
      getChainId: vi.fn(async () => 1),
      getBlock: vi.fn(async () => block),
    } as unknown as ObservatoryPublicClient;
  }

  it("market-only forwards RPC clients, pinned release, previous v2 and configured history without legacy inputs", async () => {
    const { directory, first } = await setup("spot-history");
    const previous = marketFeed();
    await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-market", dataset: previous },
    ]);
    await writeFile(
      join(directory, "ampl-rebases.json"),
      "unrelated invalid legacy input\n",
    );
    vi.stubEnv("OBSERVATORY_HISTORY_DAYS", "17");
    vi.stubEnv("AMPL_LOG_RPC_URL", "https://logs.example.invalid");
    const client = marketClient();
    const logClient = marketClient();
    const createClient = vi.fn((endpoint: string) =>
      endpoint === "https://logs.example.invalid" ? logClient : client,
    );
    const next = { ...previous, generatedAt: attemptedAt };
    const readMarket = vi.fn(async () => next);
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await refreshCommand({
      mode: "--market-only",
      now,
      createClient,
      readMarket,
    });
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(readMarket).toHaveBeenCalledExactlyOnceWith({
      client,
      logClient,
      now: now(),
      historyDays: 17,
      previous,
      release: {
        number: 25_853_823n,
        hash: HASH,
        timestamp: BigInt(Date.parse(ATTEMPT) / 1000),
        timestampIso: ATTEMPT,
      },
    });
    expect(client.getBlock).toHaveBeenCalledWith({ blockNumber: 25_853_823n });
    expect(client.getBlock).toHaveBeenCalledWith({ blockHash: HASH });
    const manifest = (await readObservatoryManifest(directory))!;
    expect(
      await readPublishedFeed(directory, manifest.feeds["spot-market"]),
    ).toEqual(next);
    for (const feed of Object.keys(first.feeds) as Array<
      keyof typeof first.feeds
    >) {
      if (feed !== "spot-market")
        expect(manifest.feeds[feed]).toEqual(first.feeds[feed]);
    }
    expect(
      JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join("")),
    ).toMatchObject({
      status: "ok",
      feed: "spot-market",
      rowCount: 2,
      observedAt: "2026-09-06T00:00:00.000Z",
    });
  });

  it("market-only failures retain the previous onchain payload", async () => {
    const { directory, first } = await setup();
    const previous = marketFeed();
    const published = await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-market", dataset: previous },
    ]);
    const client = marketClient();
    const readMarket = vi.fn(async () => {
      throw new Error("opaque private provider exception");
    });
    await expect(
      refreshCommand({
        mode: "--market-only",
        now,
        createClient: () => client,
        readMarket,
      }),
    ).rejects.toThrow("previous observations retained");
    expect(readMarket).toHaveBeenCalledWith(
      expect.objectContaining({ client, logClient: client, previous }),
    );
    const manifest = (await readObservatoryManifest(directory))!;
    expect(manifest.feeds["spot-market"]).toEqual({
      ...published.feeds["spot-market"],
      status: "error",
      message: "market-source-unavailable",
      attemptedAt,
    });
    expect(
      await readPublishedFeed(directory, manifest.feeds["spot-market"]),
    ).toEqual(previous);
    expect(manifest.feeds["spot-history"]).toEqual(first.feeds["spot-history"]);
    expect(
      await readFile(join(directory, "observatory-manifest.json"), "utf8"),
    ).not.toContain("opaque private");
  });

  it("market-only missing RPC settings retain onchain data and affect only the market feed", async () => {
    const { directory } = await setup();
    const previous = marketFeed();
    const first = await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-market", dataset: previous },
    ]);
    vi.stubEnv("ETHEREUM_RPC_URL", "");
    const createClient = vi.fn(() => marketClient());
    const readMarket = vi.fn(async () => previous);
    await expect(
      refreshCommand({ mode: "--market-only", now, createClient, readMarket }),
    ).rejects.toThrow("failure states were recorded");
    expect(createClient).not.toHaveBeenCalled();
    expect(readMarket).not.toHaveBeenCalled();
    const manifest = (await readObservatoryManifest(directory))!;
    expect(manifest.feeds["spot-market"]).toEqual({
      ...first.feeds["spot-market"],
      status: "error",
      message: "rpc-unavailable",
      attemptedAt,
    });
    for (const feed of Object.keys(first.feeds) as Array<
      keyof typeof first.feeds
    >) {
      if (feed !== "spot-market")
        expect(manifest.feeds[feed]).toEqual(first.feeds[feed]);
    }
    expect(
      await readPublishedFeed(directory, manifest.feeds["spot-market"]),
    ).toEqual(previous);
  });

  it("reports partial publication and actual retained coverage when market-only returns older history", async () => {
    const { directory } = await setup();
    const previous = marketFeed();
    const first = await publishObservatoryRefresh(directory, ATTEMPT, [
      { feed: "spot-market", dataset: previous },
    ]);
    const older = {
      ...previous,
      generatedAt: attemptedAt,
      rows: previous.rows.slice(0, 1),
    };
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await refreshCommand({
      mode: "--market-only",
      now,
      createClient: () => marketClient(),
      readMarket: async () => older,
    });
    const summary = JSON.parse(
      stdout.mock.calls.map(([value]) => String(value)).join(""),
    );
    expect(summary).toEqual({
      status: "partial",
      feed: "spot-market",
      rowCount: 2,
      observedAt: "2026-09-06T00:00:00.000Z",
      message: "history-incomplete",
    });
    expect(process.exitCode).toBe(1);
    const manifest = (await readObservatoryManifest(directory))!;
    expect(manifest.feeds["spot-market"].path).toBe(
      first.feeds["spot-market"].path,
    );
    expect(
      await readPublishedFeed(directory, manifest.feeds["spot-market"]),
    ).toEqual(previous);
  });

  it("live mode selecting only market ignores corrupt unselected feed payloads and legacy baselines", async () => {
    const { directory, first } = await setup("spot-market");
    const corruptPath = join(
      directory,
      "observatory",
      basename(first.feeds["spot-history"].path!),
    );
    await writeFile(corruptPath, "unrelated invalid JSON\n");
    await writeFile(
      join(directory, "ampl-rebases.json"),
      "unrelated invalid baseline\n",
    );
    const client = marketClient();
    const readMarket = vi.fn(async () => marketFeed());
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await refreshCommand({
      mode: "--live",
      now,
      createClient: () => client,
      readMarket,
    });
    expect(readMarket).toHaveBeenCalledWith(
      expect.objectContaining({
        previous: null,
        client,
        logClient: client,
        historyDays: 90,
      }),
    );
    const manifest = (await readObservatoryManifest(directory))!;
    expect(manifest.feeds["spot-market"].status).toBe("ok");
    expect(manifest.feeds["spot-history"]).toEqual(first.feeds["spot-history"]);
    expect(await readFile(corruptPath, "utf8")).toBe(
      "unrelated invalid JSON\n",
    );
  });

  it("records all selected feeds when their shared RPC configuration is missing", async () => {
    const { directory, first } = await setup();
    vi.stubEnv("ETHEREUM_RPC_URL", "");
    const readMarket = vi.fn(async () => {
      throw new Error("market also requires RPC");
    });
    const createClient = vi.fn(() => {
      throw new Error("must not construct a client");
    });
    await expect(
      refreshCommand({ mode: "--live", now, readMarket, createClient }),
    ).rejects.toThrow("failure states were recorded");
    const recorded = (await readObservatoryManifest(directory))!;
    expect(createClient).not.toHaveBeenCalled();
    expect(readMarket).not.toHaveBeenCalled();
    for (const [feed, state] of Object.entries(recorded.feeds)) {
      expect(feed).toBeTruthy();
      expect(state).toMatchObject({
        status: "error",
        message: "rpc-unavailable",
        attemptedAt,
      });
    }
    expect(recorded.feeds["spot-history"]).toMatchObject({
      path: first.feeds["spot-history"].path,
      observedAt: OBSERVED,
    });
    expect(recorded.feeds["spot-market"]).toMatchObject({
      status: "error",
      path: null,
      message: "rpc-unavailable",
    });
  });

  it("records a failed release read in main itself and leaves unselected market state unchanged", async () => {
    const { directory, first } = await setup("spot-history,broker-history");
    const client = {
      getBlock: async () => {
        throw new Error("opaque private provider exception");
      },
    } as unknown as ObservatoryPublicClient;
    const readMarket = vi.fn(async () => {
      throw new Error("unselected market should not run");
    });
    await expect(
      refreshCommand({
        mode: "--live",
        now,
        createClient: () => client,
        readMarket,
      }),
    ).rejects.toThrow("failure states were recorded");
    const recorded = (await readObservatoryManifest(directory))!;
    expect(recorded.feeds["spot-history"]).toMatchObject({
      status: "error",
      observedAt: OBSERVED,
      attemptedAt,
    });
    expect(recorded.feeds["broker-history"]).toMatchObject({
      status: "error",
      message: "rpc-unavailable",
      attemptedAt,
    });
    expect(recorded.feeds["spot-market"]).toEqual(first.feeds["spot-market"]);
    expect(readMarket).not.toHaveBeenCalled();
    expect(
      await readFile(join(directory, "observatory-manifest.json"), "utf8"),
    ).not.toContain("opaque private");
  });

  it("records sampling failures before dataset collection without overwriting last-good payloads", async () => {
    const { directory, first } = await setup("spot-history");
    const client = {
      getBlock: async (request: {
        blockNumber?: bigint;
        blockHash?: string;
      }) => {
        if (request.blockNumber === 22_889_951n)
          throw new Error("history unavailable");
        return {
          number: 25_853_823n,
          hash: HASH,
          timestamp: BigInt(Date.parse(OBSERVED) / 1000),
        };
      },
    } as unknown as ObservatoryPublicClient;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(
      refreshCommand({ mode: "--live", now, createClient: () => client }),
    ).rejects.toThrow("failure states were recorded");
    const recorded = (await readObservatoryManifest(directory))!;
    expect(recorded.feeds["spot-history"]).toMatchObject({
      status: "error",
      path: first.feeds["spot-history"].path,
      observedAt: OBSERVED,
      attemptedAt,
    });
    expect(
      await readPublishedFeed(directory, recorded.feeds["spot-history"]),
    ).toEqual(spotFeed());
  });

  it("uses public/data when the optional output directory is an empty environment value", async () => {
    const directory = await temporaryDirectory();
    expect(observatoryOutputDirectory(directory, "")).toBe(
      join(directory, "public/data"),
    );
    expect(observatoryOutputDirectory(directory, "data-copy")).toBe(
      join(directory, "data-copy"),
    );
  });
});

describe("exact holding-period arithmetic", () => {
  it("preserves the signed percentage", () => {
    expect(holdingPeriodPercent("100", "90")).toBe("-10.000000");
  });
});

function swapEvent(): BrokerHistoryEvent {
  return {
    blockNumber: "101",
    blockHash: HASH,
    timestamp: OBSERVED,
    transactionHash: TX,
    logIndex: "9",
    event: "SwapPerpsForUSD",
    amount: "100000000000",
    preState: {
      usdBalance: "1000000000",
      spotBalance: "1000000000000",
      usdPrice: "1000000000000000000",
      spotPrice: "1000000000000000000",
    },
    feeAttribution: "transaction-parameters-unverified",
  };
}
function transfer(
  asset: "usdc" | "spot",
  from: string,
  to: string,
  amount: bigint,
  logIndex: bigint,
): BrokerAssetTransfer {
  return {
    blockNumber: 101n,
    transactionHash: TX,
    logIndex,
    asset,
    from,
    to,
    amount,
  };
}
describe("Broker transaction ledger", () => {
  it("separates user fees, protocol fees and actual reserve deltas", () => {
    const transfers = [
      transfer(
        "spot",
        ADDRESS,
        CONTRACTS.billBroker.address,
        100000000000n,
        1n,
      ),
      transfer(
        "usdc",
        CONTRACTS.billBroker.address,
        CONTRACTS.spotFeePolicy.address,
        1000000n,
        2n,
      ),
      transfer("usdc", CONTRACTS.billBroker.address, ADDRESS, 95000000n, 3n),
    ];
    const result = buildBrokerLedger(100n, 101n, [swapEvent()], transfers);
    expect(result.events[0]).toMatchObject({
      usdcDelta: "-96000000",
      spotDelta: "100000000000",
      lpSupplyDelta: "0",
      fee: {
        asset: "usdc",
        amount: "5000000",
        protocolAmount: "1000000",
        evidence: "transaction-verified",
      },
    });
  });
  it("preserves rebates and refuses ambiguous or mixed-operation fee attribution", () => {
    const transfers = [
      transfer(
        "spot",
        ADDRESS,
        CONTRACTS.billBroker.address,
        100000000000n,
        1n,
      ),
      transfer("usdc", CONTRACTS.billBroker.address, ADDRESS, 105000000n, 3n),
    ];
    expect(
      buildBrokerLedger(100n, 101n, [swapEvent()], transfers).events[0]?.fee
        ?.amount,
    ).toBe("-5000000");
    const mint: BrokerHistoryEvent = {
      ...swapEvent(),
      event: "LpMint",
      amount: "200",
      logIndex: "10",
      preState: null,
    };
    expect(
      buildBrokerLedger(100n, 101n, [swapEvent(), mint], transfers).events[0],
    ).toMatchObject({ kind: "swap", lpSupplyDelta: "200", fee: null });
  });
  it("deduplicates self-transfer query overlap and enforces endpoint interval semantics", () => {
    const row = transfer(
      "usdc",
      CONTRACTS.billBroker.address,
      CONTRACTS.billBroker.address,
      100n,
      1n,
    );
    const ledger = buildBrokerLedger(100n, 101n, [], [row, row]);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.events[0]?.usdcDelta).toBe("0");
    expect(() => buildBrokerLedger(101n, 102n, [], [row])).toThrow("outside");
  });
});

describe("incremental AMPL indexing", () => {
  it("restores baseline epochs missing from a published feed and keeps the feed's newer epochs", async () => {
    const baseline = amplRebasesDatasetSchema.parse(
      JSON.parse(await readFile("public/data/ampl-rebases.json", "utf8")),
    );
    const rows = baseline.rows;
    const dropped = rows[rows.length - 3]!;
    const last = rows.at(-1)!;
    const newer = {
      ...last,
      epoch: (BigInt(last.epoch) + 1n).toString(),
      blockNumber: (BigInt(last.blockNumber) + 7200n).toString(),
      blockHash: HASH,
      transactionHash: TX,
      timestamp: "2026-08-29T02:00:11.000Z",
      previousTotalSupply: last.totalSupply,
    };
    // The published feed lacks one epoch, carries different log positions
    // for the shared epochs, and indexed one epoch beyond the baseline.
    const feed = {
      generatedAt: ATTEMPT,
      rows: [
        ...rows
          .filter((row) => row !== dropped)
          .map((row) => ({ ...row, logIndex: "999", tokenLogIndex: "998" })),
        newer,
      ],
    };
    const merged = mergeAmplHistoryBaseline(baseline, feed);
    expect(merged.rows).toHaveLength(rows.length + 1);
    expect(merged.rows.find((row) => row.epoch === dropped.epoch)).toEqual(
      dropped,
    );
    expect(merged.rows.find((row) => row.epoch === last.epoch)).toEqual(last);
    expect(merged.rows.at(-1)).toEqual(newer);
    expect(merged.metadata).toMatchObject({
      generatedAt: ATTEMPT,
      blockNumber: newer.blockNumber,
      blockHash: HASH,
      blockTimestamp: newer.timestamp,
    });
    expect(
      merged.rows.every(
        (row, index) =>
          index === 0 ||
          BigInt(row.epoch) > BigInt(merged.rows[index - 1]!.epoch),
      ),
    ).toBe(true);
    // A feed that only repeats the baseline leaves its metadata untouched.
    expect(
      mergeAmplHistoryBaseline(baseline, { generatedAt: ATTEMPT, rows }).metadata,
    ).toEqual(baseline.metadata);
    expect(mergeAmplHistoryBaseline(baseline, null)).toBe(baseline);
    // Disagreement on a shared epoch's identity is a fault, not a preference.
    expect(() =>
      mergeAmplHistoryBaseline(baseline, {
        generatedAt: ATTEMPT,
        rows: [{ ...last, totalSupply: "1" }],
      }),
    ).toThrow("disagrees with the release baseline");
  });

  it("reuses the last complete epoch as an anchor and preserves historical supply changes", async () => {
    const original = amplRebasesDatasetSchema.parse(
      JSON.parse(await readFile("public/data/ampl-rebases.json", "utf8")),
    );
    const previous = { ...original, rows: original.rows.slice(-2) };
    const last = previous.rows.at(-1)!;
    const anchor = BigInt(last.blockNumber);
    const next = anchor + 7200n;
    const ranges: bigint[] = [];
    const raw = (blockNumber: bigint, isPolicy: boolean) => ({
      blockNumber,
      blockHash: blockNumber === anchor ? last.blockHash : HASH,
      transactionHash: blockNumber === anchor ? last.transactionHash : TX,
      logIndex: isPolicy ? 2 : 1,
      args: isPolicy
        ? {
            epoch: BigInt(last.epoch) + (blockNumber === anchor ? 0n : 1n),
            exchangeRate: BigInt(last.exchangeRate),
            targetRate: BigInt(last.cpiAdjustedTargetRate),
            requestedSupplyAdjustment: 0n,
          }
        : {
            epoch: BigInt(last.epoch) + (blockNumber === anchor ? 0n : 1n),
            totalSupply: BigInt(last.totalSupply),
          },
    });
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        hash: blockNumber === anchor ? last.blockHash : HASH,
        timestamp:
          BigInt(Date.parse(last.timestamp) / 1000) +
          (blockNumber === anchor ? 0n : 86400n),
      }),
      getLogs: async (request: {
        fromBlock: bigint;
        address: string;
        event: { name: string };
      }) => {
        ranges.push(request.fromBlock);
        const policy =
          request.address.toLowerCase() ===
          CONTRACTS.amplPolicy.address.toLowerCase();
        if (policy && request.event.name === "LogRebase") return [];
        return [raw(anchor, policy), raw(next, policy)];
      },
    } as unknown as ObservatoryPublicClient;
    const release: ResolvedReleaseBlock = {
      number: next,
      hash: HASH,
      timestamp: BigInt(Date.parse(ATTEMPT) / 1000),
      timestampIso: ATTEMPT,
    };
    const result = await readAmplHistoryIncremental(
      {
        client,
        targetRateResolver: {
          resolveCpiAdjustedTargetRate: async () => {
            throw new Error("V2 must use emitted target");
          },
        },
      },
      release,
      ATTEMPT,
      previous,
    );
    expect(ranges.every((fromBlock) => fromBlock === anchor)).toBe(true);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[1]?.previousTotalSupply).toBe(last.previousTotalSupply);
    expect(result.rows[2]?.previousTotalSupply).toBe(last.totalSupply);
    expect(result.rows[2]?.supplyChangePercent).toBe("0");
  });
});
