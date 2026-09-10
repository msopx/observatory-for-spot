import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runConformance } from "../src/data/conformance";
import { CONTRACTS } from "../src/data/contracts";
import {
  fetchLogsAdaptive,
  pairAmplRebaseLogs,
  parseReleaseBlockRequest,
  runRefresh,
  unsupportedAmplTargetRateResolver,
  unsupportedImplementationVerifier,
  type AmplPolicyRebaseLog,
  type AmplTokenRebaseLog,
  type ObservatoryPublicClient,
  type RpcBlock,
} from "../src/data/refresh";
import { brokerQuotesDatasetSchema } from "../src/data/schemas";
import {
  sortQuotesByInput,
  sortedLpRedemptions,
} from "../src/lib/recorded-quotes";

const RELEASE_NUMBER = 23_000_000n;
const RELEASE_HASH = `0x${"11".repeat(32)}` as const;
const EVENT_BLOCK_HASH = `0x${"22".repeat(32)}` as const;
const EVENT_TRANSACTION_HASH = `0x${"33".repeat(32)}` as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function eventLog(address: string): unknown {
  const common = {
    blockNumber: RELEASE_NUMBER - 1n,
    blockHash: EVENT_BLOCK_HASH,
    transactionHash: EVENT_TRANSACTION_HASH,
  };
  if (address.toLowerCase() === CONTRACTS.amplPolicy.address.toLowerCase()) {
    return {
      ...common,
      logIndex: 2,
      args: {
        epoch: 10n,
        exchangeRate: 1_010_000_000_000_000_000n,
        cpi: 1_000_000_000_000_000_000n,
        requestedSupplyAdjustment: 100n,
        timestampSec: 1_735_783_200n,
      },
    };
  }
  return {
    ...common,
    logIndex: 1,
    args: {
      epoch: 10n,
      totalSupply: 5_000_000_000n,
    },
  };
}

class MockPublicClient implements ObservatoryPublicClient {
  async getChainId(): Promise<number> {
    return 1;
  }

  async getBlock(
    request:
      | { readonly blockHash: `0x${string}` }
      | { readonly blockNumber: bigint },
  ): Promise<RpcBlock> {
    if ("blockHash" in request && request.blockHash !== RELEASE_HASH) {
      throw new Error("unknown block");
    }
    if ("blockNumber" in request && request.blockNumber !== RELEASE_NUMBER) {
      throw new Error("unknown block");
    }
    return {
      number: RELEASE_NUMBER,
      hash: RELEASE_HASH,
      timestamp: 1_756_339_200n,
    };
  }

  async getLogs(request: {
    readonly address: `0x${string}`;
    readonly event: unknown;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly strict?: boolean;
  }): Promise<readonly unknown[]> {
    const eventName =
      request.event !== null && typeof request.event === "object"
        ? (request.event as { name?: unknown }).name
        : undefined;
    if (
      request.address.toLowerCase() ===
        CONTRACTS.amplPolicy.address.toLowerCase() &&
      eventName === "LogRebaseV2"
    ) {
      return [];
    }
    const eventBlock = RELEASE_NUMBER - 1n;
    if (request.fromBlock <= eventBlock && request.toBlock >= eventBlock) {
      return [eventLog(request.address)];
    }
    return [];
  }

  async readContract(
    request: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const address = String(request.address).toLowerCase();
    const functionName = String(request.functionName);
    const args = request.args as readonly unknown[] | undefined;

    if (functionName === "name") {
      if (address === CONTRACTS.usdc.address.toLowerCase()) {
        return "USD Coin";
      }
      if (address === CONTRACTS.amplToken.address.toLowerCase()) {
        return "Ampleforth";
      }
      return "SPOT";
    }
    if (functionName === "symbol") {
      if (address === CONTRACTS.usdc.address.toLowerCase()) {
        return "USDC";
      }
      if (address === CONTRACTS.amplToken.address.toLowerCase()) {
        return "AMPL";
      }
      return "SPOT";
    }
    if (functionName === "decimals") {
      if (address === CONTRACTS.usdc.address.toLowerCase()) {
        return 6;
      }
      if (address === CONTRACTS.spot.address.toLowerCase()) {
        return 9;
      }
      return 8;
    }
    if (functionName === "totalSupply") {
      if (address === CONTRACTS.rolloverVault.address.toLowerCase()) {
        return 1_500n;
      }
      if (address === CONTRACTS.spot.address.toLowerCase()) {
        return 1_000n;
      }
      return 5_000_000_000n;
    }
    if (functionName === "getReserveCount") {
      return 1n;
    }
    if (functionName === "underlying") {
      return CONTRACTS.amplToken.address;
    }
    if (functionName === "getReserveAt") {
      expect(args?.[0]).toBe(0n);
      return CONTRACTS.amplToken.address;
    }
    if (functionName === "getReserveTokenBalance") {
      return 1_100n;
    }
    if (functionName === "getReserveTokenValue") {
      return 1_100n;
    }
    if (functionName === "getTVL") {
      return address === CONTRACTS.rolloverVault.address.toLowerCase()
        ? 2_000n
        : 1_100n;
    }
    if (functionName === "deviationRatio") {
      return 100_000_000n;
    }
    if (functionName === "usd") {
      return CONTRACTS.usdc.address;
    }
    if (functionName === "perp") {
      return CONTRACTS.spot.address;
    }
    if (functionName === "reserveState") {
      return {
        usdBalance: 2_000_000n,
        perpBalance: 2_000_000_000n,
        usdPrice: 1_000_000_000_000_000_000n,
        perpPrice: 1_000_000_000_000_000_000n,
      };
    }
    if (functionName === "ONE") {
      return 100_000_000n;
    }
    if (functionName === "arSoftBound") {
      return [75_000_000n, 133_000_000n];
    }
    if (functionName === "arHardBound") {
      return [20_000_000n, 500_000_000n];
    }
    if (functionName === "fees") {
      return [
        0n,
        0n,
        [105_000_000n, 150_000_000n],
        [105_000_000n, 150_000_000n],
        10_000_000n,
      ];
    }
    if (functionName === "assetRatio") {
      return 100_000_000n;
    }
    // Quote mocks scale linearly with the input and honour the reserve state
    // they are given, so grids, one-unit standard quotes and post-withdrawal
    // sales all resolve from the same rule: 1 USDC (1e6) buys 999 SPOT base
    // units per USDC base unit; 1 SPOT (1e9) sells for 999,000 USDC base units.
    if (functionName === "computeUSDToPerpSwapAmt") {
      const usdIn = args?.[0] as bigint;
      const state = args?.[1] as { readonly perpBalance: bigint };
      const perpOut = usdIn * 999n;
      return perpOut > state.perpBalance ? [0n, 0n] : [perpOut, usdIn];
    }
    if (functionName === "computePerpToUSDSwapAmt") {
      const perpIn = args?.[0] as bigint;
      const state = args?.[1] as { readonly usdBalance: bigint };
      const usdOut = (perpIn * 999n) / 1_000_000n;
      return usdOut > state.usdBalance ? [0n, 0n] : [usdOut, perpIn / 1_000_000n];
    }
    if (functionName === "computeRedemptionAmts") {
      const lpAmount = args?.[0] as bigint;
      const supply = 5_000_000_000n;
      return [
        (2_000_000n * lpAmount) / supply,
        (2_000_000_000n * lpAmount) / supply,
      ];
    }
    throw new Error(`unexpected read ${functionName}`);
  }

  async getCode(): Promise<`0x${string}`> {
    return "0x6000";
  }

  async getStorageAt(request: {
    readonly address: `0x${string}`;
  }): Promise<`0x${string}`> {
    const implementation =
      request.address.toLowerCase() === CONTRACTS.spot.address.toLowerCase()
        ? "0x62cbE9F24413485F04fa62f9548c7855EC4a5425"
        : "0x6ca2E2B0F2e1964BBCceDE5b2Dd37AE25966662F";
    return `0x${"0".repeat(24)}${implementation.slice(2)}`;
  }
}

describe("read-only refresh tooling", () => {
  it("parses and cross-checks explicit release block hashes", () => {
    expect(
      parseReleaseBlockRequest(`23000000@${RELEASE_HASH}`),
    ).toEqual({
      number: RELEASE_NUMBER,
      expectedHash: RELEASE_HASH,
    });
    expect(() =>
      parseReleaseBlockRequest(
        `23000000@${RELEASE_HASH}`,
        `0x${"44".repeat(32)}`,
      ),
    ).toThrow("does not match");
    expect(() => parseReleaseBlockRequest("latest")).toThrow(
      "base-10 block number",
    );
  });

  it("adapts log ranges without skipping or duplicating blocks", async () => {
    const queried: Array<readonly [bigint, bigint]> = [];
    const client = {
      async getLogs(request: {
        readonly fromBlock: bigint;
        readonly toBlock: bigint;
      }): Promise<readonly unknown[]> {
        queried.push([request.fromBlock, request.toBlock]);
        if (request.toBlock - request.fromBlock + 1n > 2n) {
          throw new Error("provider range limit");
        }
        return Array.from(
          { length: Number(request.toBlock - request.fromBlock + 1n) },
          (_, index) => request.fromBlock + BigInt(index),
        );
      },
    } as unknown as ObservatoryPublicClient;

    const logs = await fetchLogsAdaptive({
      client,
      address: CONTRACTS.amplPolicy.address,
      event: {},
      fromBlock: 1n,
      toBlock: 5n,
      initialRange: 4n,
      maximumRange: 4n,
    });
    expect(logs).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(queried).toContainEqual([1n, 4n]);
  });

  it("shrinks a range when a provider response reaches its cap", async () => {
    const queried: Array<readonly [bigint, bigint]> = [];
    const client = {
      async getLogs(request: {
        readonly fromBlock: bigint;
        readonly toBlock: bigint;
      }): Promise<readonly bigint[]> {
        queried.push([request.fromBlock, request.toBlock]);
        return Array.from(
          { length: Number(request.toBlock - request.fromBlock + 1n) },
          (_, index) => request.fromBlock + BigInt(index),
        );
      },
    } as unknown as ObservatoryPublicClient;

    const logs = await fetchLogsAdaptive({
      client,
      address: CONTRACTS.amplPolicy.address,
      event: {},
      fromBlock: 1n,
      toBlock: 5n,
      initialRange: 5n,
      maximumRange: 5n,
      maximumLogsPerResponse: 3,
    });
    expect(logs).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(queried).toContainEqual([1n, 5n]);
    expect(queried).toContainEqual([3n, 5n]);
  });

  it("pairs AMPL events and computes deterministic supply changes", async () => {
    const policy: AmplPolicyRebaseLog[] = [
      {
        policySchema: "legacy",
        epoch: 2n,
        exchangeRate: 1n,
        cpiOracleValue: 1n,
        emittedTargetRate: null,
        requestedSupplyAdjustment: -10n,
        timestamp: 2n,
        blockNumber: 2n,
        blockHash: EVENT_BLOCK_HASH,
        transactionHash: `0x${"55".repeat(32)}`,
        logIndex: 2n,
      },
      {
        policySchema: "legacy",
        epoch: 1n,
        exchangeRate: 1n,
        cpiOracleValue: 1n,
        emittedTargetRate: null,
        requestedSupplyAdjustment: 0n,
        timestamp: 1n,
        blockNumber: 1n,
        blockHash: RELEASE_HASH,
        transactionHash: `0x${"44".repeat(32)}`,
        logIndex: 2n,
      },
    ];
    const token: AmplTokenRebaseLog[] = [
      {
        epoch: 1n,
        totalSupply: 1_000n,
        blockNumber: 1n,
        blockHash: RELEASE_HASH,
        transactionHash: `0x${"44".repeat(32)}`,
        logIndex: 1n,
      },
      {
        epoch: 2n,
        totalSupply: 900n,
        blockNumber: 2n,
        blockHash: EVENT_BLOCK_HASH,
        transactionHash: `0x${"55".repeat(32)}`,
        logIndex: 1n,
      },
    ];
    const rows = await pairAmplRebaseLogs(policy, token, {
      async resolveCpiAdjustedTargetRate({ cpiOracleValue }) {
        return cpiOracleValue;
      },
    });
    expect(rows.map((row) => row.epoch)).toEqual(["1", "2"]);
    expect(rows[1]?.previousTotalSupply).toBe("1000");
    expect(rows[1]?.supplyChangePercent).toBe("-10");
  });

  it("collapses identical duplicate emissions and rejects conflicts", async () => {
    const policy: AmplPolicyRebaseLog = {
      policySchema: "legacy",
      epoch: 30n,
      exchangeRate: 1_010_000_000_000_000_000n,
      cpiOracleValue: 1_000_000_000_000_000_000n,
      emittedTargetRate: null,
      requestedSupplyAdjustment: 100n,
      timestamp: 1_735_783_200n,
      blockNumber: RELEASE_NUMBER - 1n,
      blockHash: EVENT_BLOCK_HASH,
      transactionHash: EVENT_TRANSACTION_HASH,
      logIndex: 2n,
    };
    const token: AmplTokenRebaseLog = {
      epoch: 30n,
      totalSupply: 5_000_000_000n,
      blockNumber: RELEASE_NUMBER - 1n,
      blockHash: EVENT_BLOCK_HASH,
      transactionHash: EVENT_TRANSACTION_HASH,
      logIndex: 1n,
    };
    const resolver = {
      async resolveCpiAdjustedTargetRate({
        cpiOracleValue,
      }: {
        readonly cpiOracleValue: bigint;
      }) {
        return cpiOracleValue;
      },
    };

    const rows = await pairAmplRebaseLogs(
      [policy, { ...policy, logIndex: 10n }],
      [token, { ...token, logIndex: 9n }],
      resolver,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ logIndex: "2", tokenLogIndex: "1" });

    await expect(
      pairAmplRebaseLogs(
        [policy],
        [token, { ...token, totalSupply: token.totalSupply + 1n }],
        resolver,
      ),
    ).rejects.toThrow("Conflicting AMPL token rebase events");
  });

  it("fails explicitly when version-aware AMPL semantics are absent", async () => {
    const policy = eventLog(CONTRACTS.amplPolicy.address) as {
      args: Record<string, bigint>;
      blockNumber: bigint;
      blockHash: typeof EVENT_BLOCK_HASH;
      transactionHash: typeof EVENT_TRANSACTION_HASH;
      logIndex: number;
    };
    const token = eventLog(CONTRACTS.amplToken.address) as {
      args: Record<string, bigint>;
      blockNumber: bigint;
      blockHash: typeof EVENT_BLOCK_HASH;
      transactionHash: typeof EVENT_TRANSACTION_HASH;
      logIndex: number;
    };
    await expect(
      pairAmplRebaseLogs(
        [
          {
            policySchema: "legacy",
            epoch: policy.args.epoch ?? 0n,
            exchangeRate: policy.args.exchangeRate ?? 0n,
            cpiOracleValue: policy.args.cpi ?? 0n,
            emittedTargetRate: null,
            requestedSupplyAdjustment:
              policy.args.requestedSupplyAdjustment ?? 0n,
            timestamp: policy.args.timestampSec ?? 0n,
            blockNumber: policy.blockNumber,
            blockHash: policy.blockHash,
            transactionHash: policy.transactionHash,
            logIndex: BigInt(policy.logIndex),
          },
        ],
        [
          {
            epoch: token.args.epoch ?? 0n,
            totalSupply: token.args.totalSupply ?? 0n,
            blockNumber: token.blockNumber,
            blockHash: token.blockHash,
            transactionHash: token.transactionHash,
            logIndex: BigInt(token.logIndex),
          },
        ],
        unsupportedAmplTargetRateResolver,
      ),
    ).rejects.toThrow("version-aware AmplTargetRateResolver");
  });

  it("uses the target emitted by V2 without invoking the legacy resolver", async () => {
    const transactionHash = `0x${"66".repeat(32)}` as const;
    const rows = await pairAmplRebaseLogs(
      [
        {
          policySchema: "v2",
          epoch: 11n,
          exchangeRate: 1_020_000_000_000_000_000n,
          cpiOracleValue: null,
          emittedTargetRate: 1_010_000_000_000_000_000n,
          requestedSupplyAdjustment: 10n,
          timestamp: 1_735_869_600n,
          blockNumber: RELEASE_NUMBER,
          blockHash: RELEASE_HASH,
          transactionHash,
          logIndex: 2n,
        },
      ],
      [
        {
          epoch: 11n,
          totalSupply: 5_000_000_010n,
          blockNumber: RELEASE_NUMBER,
          blockHash: RELEASE_HASH,
          transactionHash,
          logIndex: 1n,
        },
      ],
      {
        async resolveCpiAdjustedTargetRate() {
          throw new Error("legacy resolver must not run");
        },
      },
    );
    expect(rows[0]).toMatchObject({
      policySchema: "v2",
      cpiOracleValue: null,
      cpiAdjustedTargetRate: "1010000000000000000",
    });
  });

  it("fails closed when implementation identity is unsupported", () => {
    expect(() =>
      unsupportedImplementationVerifier.verifyImplementation({
        contract: "billBroker",
        blockNumber: RELEASE_NUMBER,
        implementationAddress:
          "0x9Ce5056eEEd22e4569a39DAa670bacD277df3ef1",
        runtimeCodeHash: RELEASE_HASH,
      }),
    ).toThrow("implementation identity is unsupported");
  });

  it("refreshes JSON and CSV with a hermetic public-client mock", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "observatory-for-spot-refresh-"),
    );
    temporaryDirectories.push(outputDirectory);
    const client = new MockPublicClient();
    let logRequestCount = 0;
    const logClient = {
      getLogs(
        request: Parameters<ObservatoryPublicClient["getLogs"]>[0],
      ): Promise<readonly unknown[]> {
        logRequestCount += 1;
        return client.getLogs(request);
      },
    };
    const result = await runRefresh({
      client,
      logClient,
      releaseBlock: {
        number: RELEASE_NUMBER,
        expectedHash: RELEASE_HASH,
      },
      outputDirectory,
      targetRateResolver: {
        async resolveCpiAdjustedTargetRate({ cpiOracleValue }) {
          return cpiOracleValue;
        },
      },
      implementationVerifier: {
        verifyImplementation() {
          return undefined;
        },
      },
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      initialLogRange: 30_000_000n,
      maximumLogRange: 30_000_000n,
    });
    expect(logRequestCount).toBe(3);

    expect(result.files).toEqual([
      "ampl-rebases.json",
      "ampl-rebases.csv",
      "spot-health.json",
      "spot-health.csv",
      "broker-state.json",
      "broker-state.csv",
      "broker-quotes.json",
      "broker-quotes.csv",
      "meta.json",
    ]);
    const ampl = JSON.parse(
      await readFile(join(outputDirectory, "ampl-rebases.json"), "utf8"),
    ) as { rows: Array<{ epoch: string }> };
    expect(ampl.rows).toEqual([
      expect.objectContaining({ epoch: "10" }),
    ]);
    const brokerCsv = await readFile(
      join(outputDirectory, "broker-state.csv"),
      "utf8",
    );
    expect(brokerCsv).toContain("usd_to_spot_input");
    expect(brokerCsv).not.toContain("ETHEREUM_RPC_URL");

    const quotes = brokerQuotesDatasetSchema.parse(
      JSON.parse(
        await readFile(join(outputDirectory, "broker-quotes.json"), "utf8"),
      ) as unknown,
    );
    // Quarter-decade grid from one whole token, stopping after two
    // consecutive unavailable quotes against the mocked reserves. The file
    // order is canonical, so compare in ascending size.
    const usdToSpot = sortQuotesByInput(quotes.grid.usdToSpot);
    expect(usdToSpot.map((quote) => quote.inputAmount)).toEqual([
      "1000000",
      "1778000",
      "3162000",
      "5623000",
    ]);
    expect(usdToSpot.map((quote) => quote.available)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const spotToUsd = sortQuotesByInput(quotes.grid.spotToUsd);
    expect(spotToUsd[0]).toMatchObject({
      inputAmount: "1000000000",
      outputAmount: "999000",
      protocolFeeAmount: "1000",
    });
    expect(spotToUsd.at(-1)?.available).toBe(false);
    // LP rows: the chained sale is quoted against post-withdrawal reserves.
    const full = sortedLpRedemptions(quotes).at(-1)!;
    expect(full.lpAmount).toBe("5000000000");
    expect(full.postWithdrawalReserves).toEqual({
      usdBalance: "0",
      spotBalance: "0",
    });
    expect(full.sale?.available).toBe(false);
    const oneUnit = quotes.lpRedemptions.find(
      (row) => row.lpAmount === "100000000",
    )!;
    expect(oneUnit.usdOut).toBe("40000");
    expect(oneUnit.spotOut).toBe("40000000");
    expect(oneUnit.sale).toMatchObject({
      inputAmount: "40000000",
      available: true,
      outputAmount: "39960",
    });
    const quotesCsv = await readFile(
      join(outputDirectory, "broker-quotes.csv"),
      "utf8",
    );
    expect(quotesCsv).toContain("swap-quote");
    expect(quotesCsv).toContain("lp-redemption");
    const meta = JSON.parse(
      await readFile(join(outputDirectory, "meta.json"), "utf8"),
    ) as { files: Array<{ dataset: string }> };
    expect([...new Set(meta.files.map((file) => file.dataset))].sort()).toEqual(
      ["ampl-rebases", "broker-quotes", "broker-state", "meta", "spot-health"],
    );
  });

  it("runs live checks only through a hermetic public-client mock", async () => {
    const report = await runConformance({
      client: new MockPublicClient(),
      releaseBlock: {
        number: RELEASE_NUMBER,
        expectedHash: RELEASE_HASH,
      },
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      logWindow: 100n,
    });
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(5);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });
});
