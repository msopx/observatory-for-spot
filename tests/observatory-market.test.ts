import { describe, expect, it, vi } from "vitest";

// Keep deployed pool bytecode out of source fixtures. Only this sentinel's
// runtime hash is replaced; CREATE2 salt hashing still uses real Keccak-256.
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    keccak256: (
      value: Parameters<typeof actual.keccak256>[0],
      to?: "hex" | "bytes",
    ) =>
      value === "0x60006000" && to !== "bytes"
        ? "0x7c06da9cbc2c7692833fddc2eced589e0014f25e6816e5a13dfe6390cfb8047b"
        : actual.keccak256(value, to),
  };
});

import { CONTRACTS } from "../src/data/contracts";
import {
  readSpotMarketHistory,
  SPOT_MARKET_POOL,
  spotPoolPriceQuote,
} from "../src/data/observatory-market";
import { observatoryDatasetSchema } from "../src/data/observatory-schemas";
import type {
  ObservatoryPublicClient,
  ResolvedReleaseBlock,
} from "../src/data/refresh";

const BASE = BigInt(Date.parse("2026-08-31T00:00:00.000Z") / 1000);
const Q96 = 1n << 96n;
const PARTY = `0x${"11".repeat(20)}` as const;
const OTHER = `0x${"22".repeat(20)}` as const;
const blockHash = (number: bigint): `0x${string}` =>
  `0x${number.toString(16).padStart(64, "0")}`;
const block = (number: bigint) => ({
  number,
  hash: blockHash(number),
  timestamp: BASE + (number - 1n) * 3600n,
});
const releaseAt = (number: bigint): ResolvedReleaseBlock => ({
  ...block(number),
  timestampIso: new Date(Number(block(number).timestamp) * 1000).toISOString(),
});
const swap = (number: bigint, index = 0) => ({
  address: SPOT_MARKET_POOL.address,
  eventName: "Swap",
  removed: false,
  blockNumber: number,
  blockHash: blockHash(number),
  transactionHash: blockHash(1_000n + number * 10n + BigInt(index)),
  transactionIndex: index,
  logIndex: index,
  args: {
    sender: PARTY,
    recipient: OTHER,
    amount0: 10_000_000n,
    amount1: -10_000_000_000n,
    sqrtPriceX96: Q96 * 32n,
    tick: 69318,
    liquidity: 999n,
  },
});

function fixture(logs: ReturnType<typeof swap>[] = [], releaseNumber = 85n) {
  const getBlock = vi.fn(
    async (request: { blockNumber?: bigint; blockHash?: `0x${string}` }) =>
      block(request.blockNumber ?? BigInt(request.blockHash!)),
  );
  const getLogs = vi.fn(
    async (request: { fromBlock: bigint; toBlock: bigint }) =>
      logs.filter(
        (log) =>
          log.blockNumber >= request.fromBlock &&
          log.blockNumber <= request.toBlock,
      ),
  );
  const readContract = vi.fn(
    async (request: Readonly<Record<string, unknown>>): Promise<unknown> => {
      switch (request.functionName) {
        case "factory":
          return SPOT_MARKET_POOL.factory;
        case "token0":
          return SPOT_MARKET_POOL.token0;
        case "token1":
          return SPOT_MARKET_POOL.token1;
        case "getPool":
          return SPOT_MARKET_POOL.address;
        case "fee":
          return 10000;
        case "tickSpacing":
          return 200;
        case "decimals":
          return request.address === CONTRACTS.spot.address ? 9 : 6;
        default:
          throw new Error("Unexpected fixture read");
      }
    },
  );
  const client = {
    getChainId: vi.fn(async () => 1),
    getBlock,
    getLogs,
    readContract,
    getCode: vi.fn(async (): Promise<`0x${string}`> => "0x60006000"),
    getStorageAt: vi.fn(async () => undefined),
  } satisfies ObservatoryPublicClient;
  const release = releaseAt(releaseNumber);
  return {
    client,
    logs,
    release,
    options: {
      client,
      release,
      now: new Date(Number(release.timestamp) * 1000 + 30000),
      historyDays: 2,
    },
  };
}

describe("independent Uniswap SPOT market collector", () => {
  it("inverts token order and decimal scales exactly without floating point", () => {
    expect(spotPoolPriceQuote(Q96)).toBe("1000000000000000000000");
    expect(spotPoolPriceQuote(Q96 * 32n)).toBe("976562500000000000");
    expect(spotPoolPriceQuote(Q96 * 3n)).toBe("111111111111111111111");
    expect(spotPoolPriceQuote((1n << 160n) - 1n)).toBe("0");
    expect(() => spotPoolPriceQuote(0n)).toThrow("square-root");
    expect(() => spotPoolPriceQuote(1n << 160n)).toThrow("square-root");
  });

  it("sorts same-block swaps, deduplicates exact logs and uses the final post-swap price", async () => {
    const earlier = swap(30n),
      final = swap(30n, 1);
    final.args.sqrtPriceX96 = Q96 * 64n;
    final.args.amount0 = -3_000_000n;
    const f = fixture([final, earlier, { ...final }]);
    const dataset = await readSpotMarketHistory(f.options);
    expect(dataset.schemaVersion).toBe(2);
    expect(dataset.source).toBe("ethereum-rpc");
    expect(dataset.pool).toMatchObject({
      address: SPOT_MARKET_POOL.address,
      fee: "10000",
      quoteToken: { decimals: "6" },
    });
    expect(dataset.rows[0]).toMatchObject({
      periodStart: "2026-09-01T00:00:00.000Z",
      timestamp: "2026-09-02T00:00:00.000Z",
      fromBlock: "25",
      toBlock: "48",
      swapCount: "2",
      volumeQuote: "13000000",
      priceQuote: "244140625000000000",
      lastSwap: { blockNumber: "30", transactionIndex: "1", logIndex: "1" },
    });
    expect(dataset.rows[1]).toMatchObject({
      swapCount: "0",
      volumeQuote: "0",
      priceQuote: null,
      lastSwap: null,
    });
    expect(
      f.client.readContract.mock.calls.every(
        ([call]) => call.blockNumber === f.release.number,
      ),
    ).toBe(true);
  });

  it("uses half-open UTC days and excludes the unfinished release day", async () => {
    const f = fixture([
      swap(24n),
      swap(25n),
      swap(48n),
      swap(49n),
      swap(72n),
      swap(73n),
    ]);
    const dataset = await readSpotMarketHistory(f.options);
    expect(dataset.rows.map((row) => row.swapCount)).toEqual(["2", "2"]);
    expect(dataset.rows.map((row) => row.lastSwap?.blockNumber)).toEqual([
      "48",
      "72",
    ]);
    expect(
      f.client.getLogs.mock.calls.every(([query]) => query.toBlock < 73n),
    ).toBe(true);
  });

  it("keeps zero-volume and zero-liquidity events as qualified evidence", async () => {
    const event = swap(50n);
    event.args.amount0 = 0n;
    event.args.amount1 = 0n;
    event.args.liquidity = 0n;
    const dataset = await readSpotMarketHistory(fixture([event]).options);
    expect(dataset.rows[1]).toMatchObject({
      swapCount: "1",
      volumeQuote: "0",
      lastSwap: { liquidity: "0" },
    });
    expect(dataset.rows[1]!.priceQuote).not.toBeNull();
  });

  it.each([
    "token0",
    "token1",
    "factory",
    "getPool",
    "fee",
    "tickSpacing",
    "decimals",
  ])("fails closed on an invalid %s identity", async (field) => {
    const f = fixture();
    const original = f.client.readContract.getMockImplementation()!;
    f.client.readContract.mockImplementation(async (call) =>
      call.functionName === field
        ? ["fee", "tickSpacing", "decimals"].includes(field)
          ? 0
          : PARTY
        : original(call),
    );
    await expect(readSpotMarketHistory(f.options)).rejects.toThrow(
      "identity does not match",
    );
    expect(f.client.getLogs).not.toHaveBeenCalled();
  });

  it("requires deployed code and Ethereum chain identity", async () => {
    const f = fixture();
    f.client.getChainId.mockResolvedValue(10);
    await expect(readSpotMarketHistory(f.options)).rejects.toThrow("mainnet");
    const other = fixture();
    other.client.getCode.mockResolvedValue("0x");
    await expect(readSpotMarketHistory(other.options)).rejects.toThrow(
      "identity does not match",
    );
    const wrongRuntime = fixture();
    wrongRuntime.client.getCode.mockResolvedValue("0x60016000");
    await expect(readSpotMarketHistory(wrongRuntime.options)).rejects.toThrow(
      "runtime does not match",
    );
    expect(wrongRuntime.client.getLogs).not.toHaveBeenCalled();
  });

  it("rejects conflicting duplicate swaps instead of hiding the conflict", async () => {
    const first = swap(30n),
      conflict = swap(30n);
    conflict.args.amount0++;
    await expect(
      readSpotMarketHistory(fixture([first, conflict]).options),
    ).rejects.toThrow("conflict");
  });

  it("rejects a removed log, mismatched block hash, or unexpected pool", async () => {
    for (const mutation of [
      { removed: true },
      { blockHash: blockHash(999n) },
      { address: PARTY },
    ]) {
      const f = fixture([
        { ...swap(30n), ...mutation } as ReturnType<typeof swap>,
      ]);
      await expect(readSpotMarketHistory(f.options)).rejects.toThrow();
    }
  });

  it("splits capped log responses and deduplicates only after establishing complete ranges", async () => {
    const event = swap(30n),
      f = fixture([event]);
    f.client.getLogs.mockImplementation(async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock > 5n)
        return Array.from({ length: 1000 }, () => event);
      return f.logs.filter(
        (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
      );
    });
    const dataset = await readSpotMarketHistory(f.options);
    expect(dataset.rows[0]!.swapCount).toBe("1");
    expect(f.client.getLogs.mock.calls.length).toBeGreaterThan(2);
  });

  it("rejects an unavailable single-block page and strips provider errors", async () => {
    const f = fixture();
    f.client.getLogs.mockRejectedValue(
      new Error("provider-private-diagnostic"),
    );
    await expect(readSpotMarketHistory(f.options)).rejects.toThrow(
      "complete coverage was not collected",
    );
    try {
      await readSpotMarketHistory(f.options);
    } catch (error) {
      expect(String(error)).not.toContain("provider-private-diagnostic");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("rejects a canonical block changing during collection", async () => {
    const f = fixture([swap(30n)]),
      reads = new Map<bigint, number>();
    f.client.getBlock.mockImplementation(async (request) => {
      const number = request.blockNumber ?? BigInt(request.blockHash!);
      const count = (reads.get(number) ?? 0) + 1;
      reads.set(number, count);
      return number === 30n && count > 1
        ? { ...block(number), hash: blockHash(999n) }
        : block(number);
    });
    await expect(readSpotMarketHistory(f.options)).rejects.toThrow(
      "changed during collection",
    );
  });

  it("reuses prior coverage but re-reads the final day as the verification block advances", async () => {
    const first = fixture([swap(30n), swap(50n)]);
    const previous = await readSpotMarketHistory(first.options);
    const next = fixture([swap(30n), swap(50n), swap(80n)], 109n);
    const dataset = await readSpotMarketHistory({
      ...next.options,
      historyDays: 3,
      previous,
    });
    expect(dataset.rows).toHaveLength(3);
    expect(dataset.rows[0]).toEqual(previous.rows[0]);
    expect(dataset.rows[1]).toEqual(previous.rows[1]);
    expect(dataset.rows[2]!.lastSwap?.blockNumber).toBe("80");
    expect(dataset.pool.verifiedAt.blockNumber).toBe("109");
    expect(
      next.client.getLogs.mock.calls.map(([query]) => query.fromBlock),
    ).toEqual([49n, 73n]);
  });

  it("rejects changed prior boundaries and missing evidence in the re-read day", async () => {
    const first = fixture([swap(50n)]);
    const previous = await readSpotMarketHistory(first.options);
    const changed = fixture([swap(50n)], 109n);
    changed.client.getBlock.mockImplementation(async (request) => {
      const number = request.blockNumber ?? BigInt(request.blockHash!);
      return number === 72n
        ? { ...block(number), hash: blockHash(999n) }
        : block(number);
    });
    await expect(
      readSpotMarketHistory({ ...changed.options, previous }),
    ).rejects.toThrow("boundary");
    const missing = fixture([], 109n);
    await expect(
      readSpotMarketHistory({ ...missing.options, previous }),
    ).rejects.toThrow("changed on re-read");
  });

  it("keeps only the requested rolling window and re-reads the previous final day", async () => {
    const previous = await readSpotMarketHistory(
      fixture([swap(30n), swap(50n)]).options,
    );
    const next = fixture([swap(50n), swap(80n)], 109n);
    const dataset = await readSpotMarketHistory({ ...next.options, previous });
    expect(dataset.rows.map((row) => row.periodStart)).toEqual([
      "2026-09-02T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ]);
    expect(dataset.rows[0]).toEqual(previous.rows[1]);
  });

  it("re-reads the prior final day even when downtime excludes it from the new window", async () => {
    const previous = await readSpotMarketHistory(fixture([swap(50n)]).options);
    const next = fixture([swap(50n), swap(140n)], 181n);
    const dataset = await readSpotMarketHistory({ ...next.options, previous });
    expect(dataset.rows.map((row) => row.periodStart)).toEqual([
      "2026-09-05T00:00:00.000Z",
      "2026-09-06T00:00:00.000Z",
    ]);
    expect(
      next.client.getLogs.mock.calls
        .map(([query]) => query.fromBlock)
        .sort((a, b) => Number(a - b)),
    ).toEqual([49n, 121n, 145n]);
    const missing = fixture([], 181n);
    await expect(
      readSpotMarketHistory({ ...missing.options, previous }),
    ).rejects.toThrow("changed on re-read");
    const changedEvent = swap(50n);
    changedEvent.args.amount0++;
    const changed = fixture([changedEvent], 181n);
    await expect(
      readSpotMarketHistory({ ...changed.options, previous }),
    ).rejects.toThrow("changed on re-read");
  });

  it("rejects inflated turnover in a single-swap v2 observation", async () => {
    const dataset = await readSpotMarketHistory(fixture([swap(50n)]).options);
    dataset.rows[1]!.volumeQuote = "10000001";
    expect(observatoryDatasetSchema.safeParse(dataset).success).toBe(false);
  });
});
