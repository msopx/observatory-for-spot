import { z } from "zod";

import { CONTRACTS } from "./contracts";

import {
  amplRebaseRowSchema,
  brokerStateDatasetSchema,
  decimalStringSchema,
  evmAddressSchema,
  evmHashSchema,
  intStringSchema,
  isoUtcTimestampSchema,
  positiveUintStringSchema,
  spotReserveSchema,
  tokenDescriptorSchema,
  uintStringSchema,
} from "./schemas";

export const OBSERVATORY_SCHEMA_VERSION = 1 as const;
export const OBSERVATORY_FEEDS = [
  "ampl-history",
  "spot-history",
  "broker-history",
  "stampl-history",
  "collateral",
  "exit-inputs",
  "spot-market",
] as const;
export const observatoryFeedSchema = z.enum(OBSERVATORY_FEEDS);
export type ObservatoryFeed = z.infer<typeof observatoryFeedSchema>;

export const blockObservationSchema = z
  .object({
    blockNumber: positiveUintStringSchema,
    blockHash: evmHashSchema,
    timestamp: isoUtcTimestampSchema,
  })
  .strict();
export const implementationEvidenceSchema = z
  .object({
    address: evmAddressSchema,
    codeHash: evmHashSchema,
  })
  .strict();

export const spotHistoryPointSchema = blockObservationSchema
  .extend({
    implementation: implementationEvidenceSchema,
    collateralAmpl: uintStringSchema,
    totalSupply: uintStringSchema,
    deviationRatio: uintStringSchema,
    deviationRatioDecimals: uintStringSchema,
    // Oracle FMV is a protocol valuation, never a traded market price.
    fmvUsd: uintStringSchema.nullable(),
    reserveCount: uintStringSchema,
  })
  .strict();

export const brokerHistoryPointSchema = blockObservationSchema
  .extend({
    implementation: implementationEvidenceSchema,
    usdBalance: uintStringSchema,
    spotBalance: uintStringSchema,
    usdPrice: uintStringSchema,
    spotFmv: uintStringSchema,
    lpSupply: positiveUintStringSchema,
    lpDecimals: uintStringSchema,
    paused: z.boolean(),
    oracleStatus: z.literal("valid-at-observation"),
    parameters: brokerStateDatasetSchema.shape.parameters,
  })
  .strict();

export const brokerHistoryEventSchema = blockObservationSchema
  .extend({
    transactionHash: evmHashSchema,
    logIndex: uintStringSchema,
    event: z.enum([
      "SwapPerpsForUSD",
      "SwapUSDForPerps",
      "DepositUSD",
      "DepositPerp",
      "LpMint",
      "LpBurn",
    ]),
    amount: uintStringSchema,
    preState: brokerStateDatasetSchema.shape.reserveState.nullable(),
    // End-of-block parameters cannot prove parameters at the event transaction.
    feeAttribution: z.literal("transaction-parameters-unverified"),
  })
  .strict();

export const brokerLedgerSchema = z
  .object({
    fromBlock: positiveUintStringSchema,
    toBlock: positiveUintStringSchema,
    coverage: z.enum(["complete", "partial"]),
    events: z.array(
      z
        .object({
          blockNumber: positiveUintStringSchema,
          logIndex: uintStringSchema,
          transactionHash: evmHashSchema,
          kind: z.enum(["swap", "deposit", "withdrawal", "transfer", "other"]),
          usdcDelta: intStringSchema,
          spotDelta: intStringSchema,
          lpSupplyDelta: intStringSchema,
          fee: z
            .object({
              asset: z.enum(["usdc", "spot"]),
              amount: intStringSchema,
              protocolAmount: uintStringSchema,
              evidence: z.literal("transaction-verified"),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const stamplHistoryPointSchema = blockObservationSchema
  .extend({
    implementation: implementationEvidenceSchema,
    feePolicyImplementation: implementationEvidenceSchema,
    collateralAmpl: uintStringSchema,
    totalSupply: positiveUintStringSchema,
    decimals: uintStringSchema,
    amplPerStamplWad: uintStringSchema,
    deviationRatio: uintStringSchema,
    deviationRatioDecimals: uintStringSchema,
    // Positive value flows from stAMPL to SPOT; negative from SPOT to stAMPL.
    indicatedFundingAmpl: intStringSchema.nullable(),
    fundingPeriodSeconds: positiveUintStringSchema.nullable(),
    lastRebalanceTimestamp: uintStringSchema.nullable(),
    rebalancePaused: z.boolean().optional(),
    paused: z.boolean(),
  })
  .strict();

export const bondEvidenceSchema = z
  .object({
    address: evmAddressSchema,
    codeHash: evmHashSchema,
    maturityTimestamp: uintStringSchema,
    isMature: z.boolean(),
    collateralUnderlying: uintStringSchema,
    seniorClaim: uintStringSchema,
    seniorSupply: uintStringSchema,
    seniorToken: evmAddressSchema,
    seniorCollateral: uintStringSchema,
    heldSenior: uintStringSchema,
    identity: z.enum(["unverified", "verified"]),
  })
  .strict();
export const collateralAssetSchema = z
  .object({
    token: tokenDescriptorSchema,
    balance: uintStringSchema,
    underlyingValue: uintStringSchema,
    isUnderlying: z.boolean(),
    bond: bondEvidenceSchema.nullable(),
  })
  .strict();
export const collateralPointSchema = blockObservationSchema
  .extend({
    spotImplementation: implementationEvidenceSchema,
    vaultImplementation: implementationEvidenceSchema,
    underlying: tokenDescriptorSchema,
    spot: z.array(collateralAssetSchema),
    vault: z.array(collateralAssetSchema),
  })
  .strict();

export const redemptionQuoteSchema = z
  .object({
    inputAmount: uintStringSchema,
    available: z.boolean(),
    tokensOut: z.array(
      z.object({ token: evmAddressSchema, amount: uintStringSchema }).strict(),
    ),
    reason: z.enum(["contract-reverted", "paused"]).nullable(),
  })
  .strict()
  .superRefine((quote, ctx) => {
    if (
      (quote.available && quote.reason !== null) ||
      (!quote.available &&
        (quote.reason === null || quote.tokensOut.length > 0))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Redemption availability and outputs disagree",
      });
    }
  });
export const exitInputsPointSchema = blockObservationSchema
  .extend({
    spotImplementation: implementationEvidenceSchema,
    brokerImplementation: implementationEvidenceSchema,
    spotPaused: z.boolean(),
    brokerPaused: z.boolean(),
    spotTotalSupply: uintStringSchema,
    brokerLpSupply: positiveUintStringSchema,
    brokerLpDecimals: uintStringSchema,
    brokerBurnFeePercent: uintStringSchema,
    brokerFeeUnit: positiveUintStringSchema,
    spotReserves: z.array(spotReserveSchema),
    // Exact eth_call quotes for these amounts; do not linearly interpolate fees.
    spotRedemptions: z.array(redemptionQuoteSchema),
    brokerRedemptions: z.array(
      z
        .object({
          inputAmount: uintStringSchema,
          usdAmount: uintStringSchema,
          spotAmount: uintStringSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const marketSwapSchema = blockObservationSchema
  .extend({
    transactionHash: evmHashSchema,
    transactionIndex: uintStringSchema,
    logIndex: uintStringSchema,
    sqrtPriceX96: positiveUintStringSchema.refine(
      (value) => BigInt(value) < 2n ** 160n,
    ),
    tick: intStringSchema.refine(
      (value) => BigInt(value) >= -887272n && BigInt(value) <= 887272n,
    ),
    liquidity: uintStringSchema.refine((value) => BigInt(value) < 2n ** 128n),
    amount0: intStringSchema.refine(
      (value) => BigInt(value) >= -(2n ** 255n) && BigInt(value) < 2n ** 255n,
    ),
    amount1: intStringSchema.refine(
      (value) => BigInt(value) >= -(2n ** 255n) && BigInt(value) < 2n ** 255n,
    ),
  })
  .strict();

export const spotMarketPoolSchema = z
  .object({
    address: evmAddressSchema,
    factory: evmAddressSchema,
    token0: evmAddressSchema,
    token1: evmAddressSchema,
    baseToken: tokenDescriptorSchema,
    quoteToken: tokenDescriptorSchema,
    fee: z.literal("10000"),
    tickSpacing: z.literal("200"),
    codeHash: evmHashSchema,
    verifiedAt: blockObservationSchema,
  })
  .strict()
  .superRefine((pool, ctx) => {
    const matches = (a: string, b: string) =>
      a.toLowerCase() === b.toLowerCase();
    if (
      !matches(pool.address, "0x898aDC9aa0C23DCE3fED6456C34DbE2b57784325") ||
      !matches(pool.factory, "0x1F98431c8aD98523631AE4a59f267346ea31F984") ||
      !matches(pool.token0, CONTRACTS.usdc.address) ||
      !matches(pool.token1, CONTRACTS.spot.address) ||
      !matches(pool.baseToken.address, CONTRACTS.spot.address) ||
      !matches(pool.quoteToken.address, CONTRACTS.usdc.address) ||
      pool.baseToken.decimals !== "9" ||
      pool.quoteToken.decimals !== "6"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Unsupported SPOT/USDC pool identity",
      });
    }
  });

export const spotMarketPointSchema = z
  .object({
    // Completed UTC day boundary; the actual final swap time is kept separately.
    timestamp: isoUtcTimestampSchema,
    periodStart: isoUtcTimestampSchema,
    fromBlock: positiveUintStringSchema,
    toBlock: positiveUintStringSchema,
    toBlockHash: evmHashSchema,
    swapCount: uintStringSchema,
    volumeQuote: uintStringSchema,
    // USDC per SPOT scaled to 18 decimal places; null means no swap that day.
    priceQuote: uintStringSchema.nullable(),
    lastSwap: marketSwapSchema.nullable(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const start = Date.parse(row.periodStart),
      end = Date.parse(row.timestamp);
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (start % 86_400_000 !== 0 || end - start !== 86_400_000)
      invalid("Market observations must cover one completed UTC day");
    if (BigInt(row.fromBlock) > BigInt(row.toBlock))
      invalid("Market block interval is reversed");
    if (
      (row.priceQuote === null) !== (row.lastSwap === null) ||
      (row.swapCount === "0") !== (row.lastSwap === null)
    )
      invalid("Swap evidence and price availability disagree");
    if (row.lastSwap === null) {
      if (row.volumeQuote !== "0")
        invalid("A day without swaps cannot have turnover");
    } else {
      const swap = row.lastSwap;
      if (
        swap.timestamp < row.periodStart ||
        swap.timestamp >= row.timestamp ||
        BigInt(swap.blockNumber) < BigInt(row.fromBlock) ||
        BigInt(swap.blockNumber) > BigInt(row.toBlock)
      )
        invalid("Final swap is outside its daily interval");
      if (
        swap.blockNumber === row.toBlock &&
        swap.blockHash !== row.toBlockHash
      )
        invalid("Final swap disagrees with its boundary block hash");
      const amount = BigInt(swap.amount0);
      const absoluteQuote = amount < 0n ? -amount : amount;
      if (BigInt(row.volumeQuote) < absoluteQuote)
        invalid("Daily turnover excludes its final swap");
      if (row.swapCount === "1" && BigInt(row.volumeQuote) !== absoluteQuote)
        invalid("Single-swap turnover disagrees with its only event");
      const sqrt = BigInt(swap.sqrtPriceX96);
      if (
        sqrt > 0n &&
        row.priceQuote !==
          ((2n ** 192n * 10n ** 21n) / (sqrt * sqrt)).toString()
      )
        invalid("Price does not match the final swap sqrtPriceX96");
    }
  });

const envelope = {
  schemaVersion: z.literal(OBSERVATORY_SCHEMA_VERSION),
  generatedAt: isoUtcTimestampSchema,
  chainId: z.literal(1),
  // Stored evidence describes its actual source, never its packaging date.
  source: z.enum(["ethereum-rpc", "archived-release"]),
  notes: z.array(z.string().min(1).max(240)),
};
export const observatoryDatasetSchema = z
  .discriminatedUnion("feed", [
    z
      .object({
        ...envelope,
        feed: z.literal("ampl-history"),
        rows: z.array(amplRebaseRowSchema),
      })
      .strict(),
    z
      .object({
        ...envelope,
        feed: z.literal("spot-history"),
        rows: z.array(spotHistoryPointSchema),
      })
      .strict(),
    z
      .object({
        ...envelope,
        feed: z.literal("broker-history"),
        rows: z.array(brokerHistoryPointSchema),
        events: z.array(brokerHistoryEventSchema),
        ledger: brokerLedgerSchema.nullable().optional(),
      })
      .strict(),
    z
      .object({
        ...envelope,
        feed: z.literal("stampl-history"),
        rows: z.array(stamplHistoryPointSchema),
      })
      .strict(),
    z
      .object({
        ...envelope,
        feed: z.literal("collateral"),
        rows: z.array(collateralPointSchema),
      })
      .strict(),
    z
      .object({
        ...envelope,
        feed: z.literal("exit-inputs"),
        rows: z.array(exitInputsPointSchema),
      })
      .strict(),
    z
      .object({
        ...envelope,
        schemaVersion: z.literal(2),
        source: z.literal("ethereum-rpc"),
        feed: z.literal("spot-market"),
        pool: spotMarketPoolSchema,
        rows: z.array(spotMarketPointSchema),
      })
      .strict(),
  ])
  .superRefine((dataset, ctx) => {
    if (dataset.feed === "spot-market") {
      if (dataset.pool.verifiedAt.timestamp > dataset.generatedAt)
        ctx.addIssue({
          code: "custom",
          message: "Pool verification follows publication",
        });
      dataset.rows.forEach((row, index) => {
        const prior = dataset.rows[index - 1];
        if (
          row.timestamp > dataset.pool.verifiedAt.timestamp ||
          BigInt(row.toBlock) > BigInt(dataset.pool.verifiedAt.blockNumber)
        )
          ctx.addIssue({
            code: "custom",
            path: ["rows", index],
            message: "Market coverage exceeds its pinned verification block",
          });
        if (
          prior &&
          (row.periodStart !== prior.timestamp ||
            BigInt(row.fromBlock) !== BigInt(prior.toBlock) + 1n)
        )
          ctx.addIssue({
            code: "custom",
            path: ["rows", index],
            message:
              "Market coverage must contain consecutive complete days and block intervals",
          });
      });
    }
    let previousTimestamp: string | null = null;
    const seen = new Set<string>();
    for (const [index, row] of dataset.rows.entries()) {
      const key =
        "epoch" in row
          ? row.epoch
          : "blockNumber" in row
            ? row.blockNumber
            : row.timestamp;
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          path: ["rows", index],
          message: "Duplicate observation identity",
        });
      seen.add(key);
      if (previousTimestamp !== null && row.timestamp < previousTimestamp)
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "timestamp"],
          message: "Observations must be chronological",
        });
      if (row.timestamp > dataset.generatedAt)
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "timestamp"],
          message: "An observation cannot follow its publication time",
        });
      if ("blockHash" in row && !/^0x[0-9a-fA-F]{64}$/.test(row.blockHash))
        ctx.addIssue({
          code: "custom",
          path: ["rows", index, "blockHash"],
          message: "Observatory data requires real chain evidence",
        });
      previousTimestamp = row.timestamp;
    }
    if (dataset.feed === "broker-history" && dataset.ledger != null) {
      const start = BigInt(dataset.ledger.fromBlock);
      const end = BigInt(dataset.ledger.toBlock);
      if (start > end)
        ctx.addIssue({
          code: "custom",
          path: ["ledger"],
          message: "Ledger interval is reversed",
        });
      const txs = new Set<string>();
      for (const [index, event] of dataset.ledger.events.entries()) {
        if (
          BigInt(event.blockNumber) <= start ||
          BigInt(event.blockNumber) > end ||
          txs.has(event.transactionHash.toLowerCase())
        )
          ctx.addIssue({
            code: "custom",
            path: ["ledger", "events", index],
            message: "Ledger transaction is duplicated or outside its interval",
          });
        txs.add(event.transactionHash.toLowerCase());
      }
    }
  });

export const feedFailureSchema = z.enum([
  "rpc-unavailable",
  "read-failed",
  "implementation-unsupported",
  "history-incomplete",
  "market-source-unavailable",
  "no-verified-observations",
  "archived-snapshot",
]);
export const observatoryFeedStateSchema = z
  .object({
    status: z.enum(["ok", "error", "unsupported"]),
    path: z
      .string()
      .regex(/^\/data\/observatory\/[a-z-]+\.[a-f0-9]{64}\.json$/)
      .nullable(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    observedAt: isoUtcTimestampSchema.nullable(),
    attemptedAt: isoUtcTimestampSchema,
    message: feedFailureSchema.nullable(),
    rowCount: z.number().int().nonnegative(),
    coverage: z
      .object({
        fromBlock: positiveUintStringSchema,
        toBlock: positiveUintStringSchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (
      (state.path === null) !== (state.contentHash === null) ||
      (state.path === null &&
        (state.observedAt !== null || state.rowCount !== 0))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A feed without a published path cannot claim observations",
      });
    }
    if (
      state.status === "ok" &&
      (state.path === null || state.rowCount < 1 || state.message !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "An OK feed requires observations and no error message",
      });
    }
  });

export const observatoryManifestSchema = z
  .object({
    schemaVersion: z.literal(OBSERVATORY_SCHEMA_VERSION),
    generatedAt: isoUtcTimestampSchema,
    legacy: z
      .object({
        "ampl-rebases": z
          .object({
            path: z
              .string()
              .regex(
                /^\/data\/observatory\/legacy-ampl-rebases\.[a-f0-9]{64}\.json$/,
              ),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
        "spot-health": z
          .object({
            path: z
              .string()
              .regex(
                /^\/data\/observatory\/legacy-spot-health\.[a-f0-9]{64}\.json$/,
              ),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
        "broker-state": z
          .object({
            path: z
              .string()
              .regex(
                /^\/data\/observatory\/legacy-broker-state\.[a-f0-9]{64}\.json$/,
              ),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    feeds: z
      .object({
        "ampl-history": observatoryFeedStateSchema,
        "spot-history": observatoryFeedStateSchema,
        "broker-history": observatoryFeedStateSchema,
        "stampl-history": observatoryFeedStateSchema,
        collateral: observatoryFeedStateSchema,
        "exit-inputs": observatoryFeedStateSchema,
        "spot-market": observatoryFeedStateSchema,
      })
      .strict(),
  })
  .strict();

export type ObservatoryDataset = z.infer<typeof observatoryDatasetSchema>;
export type ObservatoryDatasetFor<F extends ObservatoryFeed> = Extract<
  ObservatoryDataset,
  { feed: F }
>;
export type ObservatoryManifest = z.infer<typeof observatoryManifestSchema>;
export type ObservatoryFeedState = z.infer<typeof observatoryFeedStateSchema>;
export type FeedFailure = z.infer<typeof feedFailureSchema>;
export type SpotHistoryPoint = z.infer<typeof spotHistoryPointSchema>;
export type BrokerHistoryPoint = z.infer<typeof brokerHistoryPointSchema>;
export type BrokerHistoryEvent = z.infer<typeof brokerHistoryEventSchema>;
export type BrokerLedger = z.infer<typeof brokerLedgerSchema>;
export type StamplHistoryPoint = z.infer<typeof stamplHistoryPointSchema>;
export type CollateralPoint = z.infer<typeof collateralPointSchema>;
export type CollateralAsset = z.infer<typeof collateralAssetSchema>;
export type ExitInputsPoint = z.infer<typeof exitInputsPointSchema>;
export type SpotMarketPoint = z.infer<typeof spotMarketPointSchema>;
export type SpotMarketPool = z.infer<typeof spotMarketPoolSchema>;
export type MarketSwap = z.infer<typeof marketSwapSchema>;
export type BlockObservation = z.infer<typeof blockObservationSchema>;
export type ImplementationEvidence = z.infer<
  typeof implementationEvidenceSchema
>;

/** Exact decimal percent; null signals an unavailable denominator. */
export function holdingPeriodPercent(
  start: string,
  end: string,
): string | null {
  const first = BigInt(start);
  if (first <= 0n) return null;
  const scaled = ((BigInt(end) - first) * 100_000_000n) / first;
  const sign = scaled < 0n ? "-" : "";
  const absolute = scaled < 0n ? -scaled : scaled;
  const text = `${sign}${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
  return decimalStringSchema.parse(text);
}
