import { z } from "zod";

export const DATA_SCHEMA_VERSION = 1 as const;
export const DEVELOPMENT_FIXTURE_LABEL =
  "DEVELOPMENT FIXTURE — NOT FINAL" as const;

const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const INT_PATTERN = /^(0|-?[1-9][0-9]*)$/;
const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ISO_UTC_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const FIXTURE_HASH_PATTERN =
  /^fixture:(?:block|code|tx):[a-z0-9][a-z0-9._-]{0,95}$/;

export const uintStringSchema = z
  .string()
  .regex(UINT_PATTERN, "Expected an unsigned base-10 integer string");

export const positiveUintStringSchema = uintStringSchema.refine(
  (value) => value !== "0",
  "Expected a positive base-10 integer string",
);

export const intStringSchema = z
  .string()
  .regex(INT_PATTERN, "Expected a signed base-10 integer string");

export const decimalStringSchema = z
  .string()
  .regex(DECIMAL_PATTERN, "Expected a canonical base-10 decimal string")
  .refine((value) => value !== "-0", "Negative zero is not canonical");

export const isoUtcTimestampSchema = z
  .string()
  .regex(ISO_UTC_PATTERN, "Expected an ISO-8601 UTC timestamp")
  .refine((value) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }
    const normalized = value.includes(".")
      ? value
      : value.replace("Z", ".000Z");
    return parsed.toISOString() === normalized;
  }, "Expected a real calendar timestamp in UTC");

export const evmAddressSchema = z
  .string()
  .regex(EVM_ADDRESS_PATTERN, "Expected a 20-byte EVM address");

export const evmHashSchema = z
  .string()
  .regex(EVM_HASH_PATTERN, "Expected a 32-byte EVM hash");

export const fixtureHashSchema = z
  .string()
  .regex(
    FIXTURE_HASH_PATTERN,
    "Expected an explicitly labelled fixture block, code, or transaction hash",
  );

export const blockHashSchema = z.union([
  evmHashSchema,
  fixtureHashSchema.refine(
    (value) => value.startsWith("fixture:block:"),
    "Expected a fixture block hash",
  ),
]);

export const transactionHashSchema = z.union([
  evmHashSchema,
  fixtureHashSchema.refine(
    (value) => value.startsWith("fixture:tx:"),
    "Expected a fixture transaction hash",
  ),
]);

export const codeHashSchema = z.union([
  evmHashSchema,
  fixtureHashSchema.refine(
    (value) => value.startsWith("fixture:code:"),
    "Expected a fixture runtime-code hash",
  ),
]);

const shortTextSchema = z.string().trim().min(1).max(240);
const identifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,95}$/);

export const datasetNameSchema = z.enum([
  "meta",
  "ampl-rebases",
  "spot-health",
  "broker-state",
  "broker-quotes",
]);

export const contractReferenceSchema = z
  .object({
    role: identifierSchema,
    address: evmAddressSchema,
    deploymentBlock: uintStringSchema.nullable(),
  })
  .strict();

const fixtureProvenanceSchema = z
  .object({
    kind: z.literal("fixture"),
    label: z.literal(DEVELOPMENT_FIXTURE_LABEL),
    fixtureId: identifierSchema,
    generator: shortTextSchema,
    contracts: z.array(contractReferenceSchema),
    notes: z.array(shortTextSchema),
  })
  .strict();

const rpcProvenanceSchema = z
  .object({
    kind: z.literal("ethereum-rpc"),
    generator: shortTextSchema,
    contracts: z.array(contractReferenceSchema),
    notes: z.array(shortTextSchema),
  })
  .strict();

export const provenanceSchema = z.discriminatedUnion("kind", [
  fixtureProvenanceSchema,
  rpcProvenanceSchema,
]);

function validateMetadataSource(
  metadata: {
    status: "fixture-not-final" | "release";
    blockNumber: string;
    blockHash: string;
    blockTimestamp: string | null;
    provenance:
      | z.infer<typeof fixtureProvenanceSchema>
      | z.infer<typeof rpcProvenanceSchema>;
  },
  context: z.RefinementCtx,
): void {
  if (metadata.provenance.kind === "fixture") {
    if (metadata.status !== "fixture-not-final") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Fixture provenance requires fixture-not-final status",
      });
    }
    if (metadata.blockNumber !== "0") {
      context.addIssue({
        code: "custom",
        path: ["blockNumber"],
        message: "Development fixtures must use block number 0",
      });
    }
    if (!metadata.blockHash.startsWith("fixture:block:")) {
      context.addIssue({
        code: "custom",
        path: ["blockHash"],
        message: "Development fixtures must use an explicit fixture block hash",
      });
    }
    return;
  }

  if (metadata.status !== "release") {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Ethereum RPC provenance requires release status",
    });
  }
  if (metadata.blockNumber === "0") {
    context.addIssue({
      code: "custom",
      path: ["blockNumber"],
      message: "A release block number must be positive",
    });
  }
  if (!EVM_HASH_PATTERN.test(metadata.blockHash)) {
    context.addIssue({
      code: "custom",
      path: ["blockHash"],
      message: "Ethereum RPC provenance requires a real EVM block hash",
    });
  }
  if (metadata.blockTimestamp === null) {
    context.addIssue({
      code: "custom",
      path: ["blockTimestamp"],
      message: "Ethereum RPC provenance requires the release block timestamp",
    });
  }
}

const metadataShape = {
  schemaVersion: z.literal(DATA_SCHEMA_VERSION),
  dataset: datasetNameSchema,
  status: z.enum(["fixture-not-final", "release"]),
  generatedAt: isoUtcTimestampSchema,
  chainId: z.literal(1),
  blockNumber: uintStringSchema,
  blockHash: blockHashSchema,
  blockTimestamp: isoUtcTimestampSchema.nullable(),
  provenance: provenanceSchema,
} as const;

export const metadataSchema = z
  .object(metadataShape)
  .strict()
  .superRefine(validateMetadataSource);

function metadataFor(dataset: z.infer<typeof datasetNameSchema>) {
  return z
    .object({
      ...metadataShape,
      dataset: z.literal(dataset),
    })
    .strict()
    .superRefine(validateMetadataSource);
}

export const tokenDescriptorSchema = z
  .object({
    address: evmAddressSchema,
    name: shortTextSchema.nullable(),
    symbol: shortTextSchema.nullable(),
    decimals: uintStringSchema.refine(
      (value) => BigInt(value) <= 255n,
      "ERC-20 decimals must fit in uint8",
    ),
  })
  .strict();

export const amplRebaseRowSchema = z
  .object({
    epoch: uintStringSchema,
    timestamp: isoUtcTimestampSchema,
    blockNumber: uintStringSchema,
    blockHash: blockHashSchema,
    transactionHash: transactionHashSchema,
    logIndex: uintStringSchema,
    tokenLogIndex: uintStringSchema,
    policySchema: z.enum(["legacy", "v2"]),
    exchangeRate: uintStringSchema,
    cpiOracleValue: uintStringSchema.nullable(),
    cpiAdjustedTargetRate: uintStringSchema,
    requestedSupplyAdjustment: intStringSchema,
    totalSupply: uintStringSchema,
    previousTotalSupply: uintStringSchema.nullable(),
    supplyChangePercent: decimalStringSchema.nullable(),
  })
  .strict();

export const amplRebasesDatasetSchema = z
  .object({
    metadata: metadataFor("ampl-rebases"),
    rateDecimals: uintStringSchema,
    supplyDecimals: uintStringSchema,
    rows: z.array(amplRebaseRowSchema),
  })
  .strict()
  .superRefine((dataset, context) => {
    const seenEpochs = new Set<string>();
    dataset.rows.forEach((row, index) => {
      if (seenEpochs.has(row.epoch)) {
        context.addIssue({
          code: "custom",
          path: ["rows", index, "epoch"],
          message: "AMPL epochs must be unique",
        });
      }
      seenEpochs.add(row.epoch);

      const isFixture = dataset.metadata.provenance.kind === "fixture";
      const fixtureHashes =
        row.blockHash.startsWith("fixture:block:") &&
        row.transactionHash.startsWith("fixture:tx:");
      const evmHashes =
        EVM_HASH_PATTERN.test(row.blockHash) &&
        EVM_HASH_PATTERN.test(row.transactionHash);
      if ((isFixture && !fixtureHashes) || (!isFixture && !evmHashes)) {
        context.addIssue({
          code: "custom",
          path: ["rows", index],
          message:
            "Row hashes must match the fixture or Ethereum RPC provenance kind",
        });
      }
      if (BigInt(row.blockNumber) > BigInt(dataset.metadata.blockNumber)) {
        context.addIssue({
          code: "custom",
          path: ["rows", index, "blockNumber"],
          message: "A rebase cannot occur after the dataset release block",
        });
      }
    });
  });

export const spotReserveSchema = z
  .object({
    token: tokenDescriptorSchema,
    balance: uintStringSchema,
    underlyingValue: uintStringSchema,
    isUnderlying: z.boolean(),
    bondAddress: evmAddressSchema.nullable(),
    maturityTimestamp: uintStringSchema.nullable(),
    maturity: isoUtcTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((reserve, context) => {
    const hasBondMetadata =
      reserve.bondAddress !== null &&
      reserve.maturityTimestamp !== null &&
      reserve.maturity !== null;
    const hasNoBondMetadata =
      reserve.bondAddress === null &&
      reserve.maturityTimestamp === null &&
      reserve.maturity === null;
    if (!hasBondMetadata && !hasNoBondMetadata) {
      context.addIssue({
        code: "custom",
        message: "Bond address and maturity fields must be all present or all null",
      });
    }
    if (reserve.isUnderlying && !hasNoBondMetadata) {
      context.addIssue({
        code: "custom",
        message: "The underlying reserve cannot have bond maturity metadata",
      });
    }
  });

export const spotHealthDatasetSchema = z
  .object({
    metadata: metadataFor("spot-health"),
    rolloverVault: z
      .object({
        address: evmAddressSchema,
        deviationRatio: uintStringSchema,
        deviationRatioDecimals: uintStringSchema,
        tvl: uintStringSchema,
        totalSupply: uintStringSchema,
      })
      .strict(),
    spot: z
      .object({
        address: evmAddressSchema,
        implementationAddress: evmAddressSchema,
        implementationCodeHash: codeHashSchema,
        collateralTvl: uintStringSchema,
        totalSupply: uintStringSchema,
        collateralCoverage: decimalStringSchema.nullable(),
        collateralCoverageNumerator: uintStringSchema,
        collateralCoverageDenominator: uintStringSchema,
      })
      .strict(),
    reserves: z.array(spotReserveSchema),
  })
  .strict()
  .superRefine((dataset, context) => {
    const fixtureCodeHash =
      dataset.spot.implementationCodeHash.startsWith("fixture:code:");
    if (
      (dataset.metadata.provenance.kind === "fixture") !== fixtureCodeHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["spot", "implementationCodeHash"],
        message:
          "Implementation code hash must match the fixture or RPC provenance kind",
      });
    }
    const addresses = new Set<string>();
    let underlyingCount = 0;
    dataset.reserves.forEach((reserve, index) => {
      const address = reserve.token.address.toLowerCase();
      if (addresses.has(address)) {
        context.addIssue({
          code: "custom",
          path: ["reserves", index, "token", "address"],
          message: "SPOT reserve token addresses must be unique",
        });
      }
      addresses.add(address);
      if (reserve.isUnderlying) {
        underlyingCount += 1;
      }
    });
    if (dataset.reserves.length > 0 && underlyingCount !== 1) {
      context.addIssue({
        code: "custom",
        path: ["reserves"],
        message: "A non-empty SPOT reserve set must identify one underlying token",
      });
    }
    if (
      dataset.spot.collateralCoverageDenominator !== dataset.spot.totalSupply ||
      dataset.spot.collateralCoverageNumerator !== dataset.spot.collateralTvl
    ) {
      context.addIssue({
        code: "custom",
        path: ["spot", "collateralCoverage"],
        message: "Collateral coverage operands must match SPOT TVL and supply",
      });
    }
  });

export const rangeSchema = z
  .object({
    lower: uintStringSchema,
    upper: uintStringSchema,
  })
  .strict()
  .refine(
    (range) => BigInt(range.lower) <= BigInt(range.upper),
    "Range lower bound must not exceed its upper bound",
  );

export const brokerQuoteSchema = z
  .object({
    inputAsset: evmAddressSchema,
    outputAsset: evmAddressSchema,
    inputAmount: uintStringSchema,
    available: z.boolean(),
    outputAmount: uintStringSchema.nullable(),
    protocolFeeAmount: uintStringSchema.nullable(),
    // Recorded outcomes only: "zero-output" means the call returned an output
    // of zero (the contract declined the size or the amount rounded to zero);
    // no cause is inferred from it.
    unavailableReason: z
      .enum(["zero-output", "contract-reverted", "fixture-not-evaluated"])
      .nullable(),
  })
  .strict()
  .superRefine((quote, context) => {
    if (quote.available) {
      if (
        quote.outputAmount === null ||
        quote.protocolFeeAmount === null ||
        quote.unavailableReason !== null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "An available quote requires output and fee amounts and no failure reason",
        });
      }
      return;
    }
    if (
      quote.outputAmount !== null ||
      quote.protocolFeeAmount !== null ||
      quote.unavailableReason === null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An unavailable quote requires null amounts and an explicit reason",
      });
    }
  });

export const brokerStateDatasetSchema = z
  .object({
    metadata: metadataFor("broker-state"),
    brokerAddress: evmAddressSchema,
    implementationAddress: evmAddressSchema,
    implementationCodeHash: codeHashSchema,
    usdToken: tokenDescriptorSchema,
    spotToken: tokenDescriptorSchema,
    reserveState: z
      .object({
        usdBalance: uintStringSchema,
        spotBalance: uintStringSchema,
        usdPrice: uintStringSchema,
        spotPrice: uintStringSchema,
      })
      .strict(),
    assetRatio: uintStringSchema,
    parameters: z
      .object({
        decimals: uintStringSchema,
        one: uintStringSchema,
        softAssetRatioBounds: rangeSchema,
        hardAssetRatioBounds: rangeSchema,
        fees: z
          .object({
            mintFeePercent: uintStringSchema,
            burnFeePercent: uintStringSchema,
            spotToUsdFeeFactors: rangeSchema,
            usdToSpotFeeFactors: rangeSchema,
            protocolSwapSharePercent: uintStringSchema,
          })
          .strict(),
      })
      .strict(),
    quotes: z
      .object({
        usdToSpot: brokerQuoteSchema,
        spotToUsd: brokerQuoteSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((dataset, context) => {
    const fixtureCodeHash =
      dataset.implementationCodeHash.startsWith("fixture:code:");
    if (
      (dataset.metadata.provenance.kind === "fixture") !== fixtureCodeHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["implementationCodeHash"],
        message:
          "Implementation code hash must match the fixture or RPC provenance kind",
      });
    }
    if (dataset.quotes.usdToSpot.inputAmount !== "1000000") {
      context.addIssue({
        code: "custom",
        path: ["quotes", "usdToSpot", "inputAmount"],
        message: "The fixed USDC quote input must be 1000000 base units",
      });
    }
    if (dataset.quotes.spotToUsd.inputAmount !== "1000000000") {
      context.addIssue({
        code: "custom",
        path: ["quotes", "spotToUsd", "inputAmount"],
        message: "The fixed SPOT quote input must be 1000000000 base units",
      });
    }

    const usdAddress = dataset.usdToken.address.toLowerCase();
    const spotAddress = dataset.spotToken.address.toLowerCase();
    const usdToSpot = dataset.quotes.usdToSpot;
    const spotToUsd = dataset.quotes.spotToUsd;
    if (
      usdToSpot.inputAsset.toLowerCase() !== usdAddress ||
      usdToSpot.outputAsset.toLowerCase() !== spotAddress ||
      spotToUsd.inputAsset.toLowerCase() !== spotAddress ||
      spotToUsd.outputAsset.toLowerCase() !== usdAddress
    ) {
      context.addIssue({
        code: "custom",
        path: ["quotes"],
        message: "Quote asset addresses must match the dataset token descriptors",
      });
    }
  });

/**
 * How the recorded quote grid was chosen. Sizes are one whole token times a
 * quarter-decade mantissa (stored in thousandths so the grid is integer
 * arithmetic, not floating point) times a power of ten. Recording stops after
 * `stopAfterUnavailable` consecutive unavailable quotes or `maximumPoints`.
 */
export const brokerQuoteGridDefinitionSchema = z
  .object({
    quarterDecadeMantissasThousandths: z
      .array(positiveUintStringSchema)
      .min(1)
      .max(8),
    maximumPoints: z.number().int().min(1).max(200),
    stopAfterUnavailable: z.number().int().min(1).max(10),
    /** Fractions of LP supply, in basis points, for the LP redemption grid. */
    lpSupplyBasisPoints: z.array(positiveUintStringSchema).min(1).max(20),
  })
  .strict();

/**
 * One recorded `computeRedemptionAmts(lpAmount)` result and, when SPOT was
 * redeemed, the recorded `computePerpToUSDSwapAmt` quote for selling all of it
 * against the post-withdrawal reserves. Every number is a contract output or
 * a subtraction of two contract outputs; no fee model is applied here.
 */
export const lpRedemptionQuoteSchema = z
  .object({
    lpAmount: positiveUintStringSchema,
    available: z.boolean(),
    usdOut: uintStringSchema.nullable(),
    spotOut: uintStringSchema.nullable(),
    unavailableReason: z
      .enum(["contract-reverted", "fixture-not-evaluated"])
      .nullable(),
    postWithdrawalReserves: z
      .object({
        usdBalance: uintStringSchema,
        spotBalance: uintStringSchema,
      })
      .strict()
      .nullable(),
    sale: brokerQuoteSchema.nullable(),
  })
  .strict()
  .superRefine((redemption, context) => {
    if (redemption.available) {
      if (
        redemption.usdOut === null ||
        redemption.spotOut === null ||
        redemption.postWithdrawalReserves === null ||
        redemption.unavailableReason !== null
      ) {
        context.addIssue({
          code: "custom",
          message:
            "An available redemption requires both amounts, post-withdrawal reserves and no failure reason",
        });
        return;
      }
      if ((redemption.spotOut === "0") !== (redemption.sale === null)) {
        context.addIssue({
          code: "custom",
          path: ["sale"],
          message:
            "A sale quote is recorded exactly when SPOT was redeemed",
        });
      }
      if (
        redemption.sale !== null &&
        redemption.sale.inputAmount !== redemption.spotOut
      ) {
        context.addIssue({
          code: "custom",
          path: ["sale", "inputAmount"],
          message: "The sale input must be the redeemed SPOT amount",
        });
      }
      return;
    }
    if (
      redemption.usdOut !== null ||
      redemption.spotOut !== null ||
      redemption.postWithdrawalReserves !== null ||
      redemption.sale !== null ||
      redemption.unavailableReason === null
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An unavailable redemption requires null amounts and an explicit reason",
      });
    }
  });

/**
 * Recorded Bill Broker quotes at the release block: trade-size grids in both
 * directions and an LP redemption grid with the chained sale. Everything is
 * an `eth_call` output of the deployed contract; the dataset contains no
 * computed quote.
 */
export const brokerQuotesDatasetSchema = z
  .object({
    metadata: metadataFor("broker-quotes"),
    brokerAddress: evmAddressSchema,
    implementationAddress: evmAddressSchema,
    implementationCodeHash: codeHashSchema,
    usdToken: tokenDescriptorSchema,
    spotToken: tokenDescriptorSchema,
    reserveState: z
      .object({
        usdBalance: uintStringSchema,
        spotBalance: uintStringSchema,
        usdPrice: uintStringSchema,
        spotPrice: uintStringSchema,
      })
      .strict(),
    lpSupply: uintStringSchema,
    lpDecimals: uintStringSchema.refine(
      (value) => BigInt(value) <= 255n,
      "LP decimals must fit in uint8",
    ),
    burnFeePercent: uintStringSchema,
    grid: z
      .object({
        definition: brokerQuoteGridDefinitionSchema,
        spotToUsd: z.array(brokerQuoteSchema).min(1),
        usdToSpot: z.array(brokerQuoteSchema).min(1),
      })
      .strict(),
    lpRedemptions: z.array(lpRedemptionQuoteSchema).min(1),
  })
  .strict()
  .superRefine((dataset, context) => {
    const fixtureCodeHash =
      dataset.implementationCodeHash.startsWith("fixture:code:");
    if (
      (dataset.metadata.provenance.kind === "fixture") !== fixtureCodeHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["implementationCodeHash"],
        message:
          "Implementation code hash must match the fixture or RPC provenance kind",
      });
    }
    const usdAddress = dataset.usdToken.address.toLowerCase();
    const spotAddress = dataset.spotToken.address.toLowerCase();
    const directions = [
      ["spotToUsd", dataset.grid.spotToUsd, spotAddress, usdAddress, dataset.spotToken.decimals],
      ["usdToSpot", dataset.grid.usdToSpot, usdAddress, spotAddress, dataset.usdToken.decimals],
    ] as const;
    // Serialized arrays are canonically ordered by the writer, not by size, so
    // readers sort by amount; the schema requires uniqueness and a one-unit point.
    for (const [name, quotes, inputAsset, outputAsset, decimals] of directions) {
      const unit = (10n ** BigInt(decimals)).toString();
      const inputs = quotes.map((quote) => quote.inputAmount);
      if (inputs.filter((input) => input === unit).length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["grid", name],
          message: "The grid must contain exactly one whole-token quote",
        });
      }
      if (new Set(inputs).size !== inputs.length) {
        context.addIssue({
          code: "custom",
          path: ["grid", name],
          message: "Grid inputs must be unique",
        });
      }
      for (const [index, quote] of quotes.entries()) {
        if (
          quote.inputAsset.toLowerCase() !== inputAsset ||
          quote.outputAsset.toLowerCase() !== outputAsset
        ) {
          context.addIssue({
            code: "custom",
            path: ["grid", name, index],
            message:
              "Quote asset addresses must match the dataset token descriptors",
          });
        }
      }
    }
    const lpAmounts = dataset.lpRedemptions.map((row) => row.lpAmount);
    if (new Set(lpAmounts).size !== lpAmounts.length) {
      context.addIssue({
        code: "custom",
        path: ["lpRedemptions"],
        message: "LP amounts must be unique",
      });
    }
    for (const [index, redemption] of dataset.lpRedemptions.entries()) {
      const lpAmount = BigInt(redemption.lpAmount);
      if (lpAmount > BigInt(dataset.lpSupply)) {
        context.addIssue({
          code: "custom",
          path: ["lpRedemptions", index, "lpAmount"],
          message: "LP amounts must be within LP supply",
        });
      }
      if (redemption.available && redemption.postWithdrawalReserves !== null) {
        const usdOut = BigInt(redemption.usdOut ?? "0");
        const spotOut = BigInt(redemption.spotOut ?? "0");
        if (
          BigInt(redemption.postWithdrawalReserves.usdBalance) + usdOut !==
            BigInt(dataset.reserveState.usdBalance) ||
          BigInt(redemption.postWithdrawalReserves.spotBalance) + spotOut !==
            BigInt(dataset.reserveState.spotBalance)
        ) {
          context.addIssue({
            code: "custom",
            path: ["lpRedemptions", index, "postWithdrawalReserves"],
            message:
              "Post-withdrawal reserves must equal the recorded reserves minus the redeemed amounts",
          });
        }
        if (
          redemption.sale !== null &&
          (redemption.sale.inputAsset.toLowerCase() !== spotAddress ||
            redemption.sale.outputAsset.toLowerCase() !== usdAddress)
        ) {
          context.addIssue({
            code: "custom",
            path: ["lpRedemptions", index, "sale"],
            message: "The chained sale must sell SPOT for USDC",
          });
        }
      }
    }
  });

export const metaFileSchema = z
  .object({
    dataset: datasetNameSchema,
    path: z.string().regex(/^\/data\/[a-z0-9][a-z0-9.-]*\.(?:json|csv)$/),
    format: z.enum(["json", "csv"]),
    status: z.enum(["fixture-not-final", "release"]),
    schemaVersion: z.literal(DATA_SCHEMA_VERSION),
  })
  .strict();

export const metaDatasetSchema = z
  .object({
    metadata: metadataFor("meta"),
    files: z.array(metaFileSchema),
  })
  .strict();

export const conformanceCheckSchema = z
  .object({
    id: identifierSchema,
    status: z.enum(["pass", "fail"]),
    message: shortTextSchema,
  })
  .strict();

export const conformanceReportSchema = z
  .object({
    schemaVersion: z.literal(DATA_SCHEMA_VERSION),
    report: z.literal("ethereum-rpc-conformance"),
    generatedAt: isoUtcTimestampSchema,
    chainId: z.literal(1),
    observedChainId: uintStringSchema.nullable(),
    blockNumber: uintStringSchema,
    blockHash: evmHashSchema.nullable(),
    passed: z.boolean(),
    checks: z.array(conformanceCheckSchema),
  })
  .strict()
  .superRefine((report, context) => {
    const checksPassed = report.checks.every((check) => check.status === "pass");
    if (report.passed !== checksPassed) {
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "Report pass status must equal the aggregate check status",
      });
    }
  });

function compatibilityHeader(metadata: DatasetMetadata) {
  return {
    schemaVersion: metadata.schemaVersion,
    status:
      metadata.provenance.kind === "fixture"
        ? ("fixture" as const)
        : ("release" as const),
    chainId: metadata.chainId,
    block: {
      number: metadata.blockNumber,
      hash: metadata.blockHash,
      timestamp: metadata.blockTimestamp ?? metadata.generatedAt,
    },
    generatedAt: metadata.generatedAt,
    source:
      metadata.provenance.kind === "fixture"
        ? metadata.provenance.label
        : `ethereum-mainnet:${metadata.blockHash}`,
  };
}

function actualSupplyChangeWad(row: AmplRebaseRow): string | null {
  if (row.previousTotalSupply === null) {
    return null;
  }
  const previous = BigInt(row.previousTotalSupply);
  if (previous === 0n) {
    return null;
  }
  return (
    ((BigInt(row.totalSupply) - previous) * 1_000_000_000_000_000_000n) /
    previous
  ).toString();
}

/**
 * Compatibility views keep the independently-built static UI decoupled from
 * the richer persisted schemas. They validate the canonical dataset first and
 * then expose the legacy read model without weakening on-disk validation.
 */
export const amplDatasetSchema = amplRebasesDatasetSchema.transform(
  (dataset) => ({
    ...compatibilityHeader(dataset.metadata),
    rows: dataset.rows.map((row) => ({
      epoch: row.epoch,
      blockNumber: row.blockNumber,
      blockHash: row.blockHash,
      transactionHash: row.transactionHash,
      timestamp: row.timestamp,
      exchangeRate: row.exchangeRate,
      targetRate: row.cpiAdjustedTargetRate,
      requestedSupplyAdjustment: row.requestedSupplyAdjustment,
      totalSupply: row.totalSupply,
      previousTotalSupply: row.previousTotalSupply,
      actualSupplyChangeWad: actualSupplyChangeWad(row),
      policySchema: row.policySchema,
    })),
  }),
);

export const spotDatasetSchema = spotHealthDatasetSchema.transform(
  (dataset) => {
    const supply = BigInt(dataset.spot.totalSupply);
    const collateralExchangeRateWad =
      supply === 0n
        ? "0"
        : (
            (BigInt(dataset.spot.collateralTvl) *
              1_000_000_000_000_000_000n) /
            supply
          ).toString();
    return {
      ...compatibilityHeader(dataset.metadata),
      implementation: dataset.spot.implementationAddress,
      implementationCodeHash: dataset.spot.implementationCodeHash,
      deviationRatio: dataset.rolloverVault.deviationRatio,
      rolloverVaultTvl: dataset.rolloverVault.tvl,
      spotTvl: dataset.spot.collateralTvl,
      spotTotalSupply: dataset.spot.totalSupply,
      collateralExchangeRateWad,
      reserves: dataset.reserves.map((reserve) => ({
        token: reserve.token.address,
        symbol: reserve.token.symbol ?? "UNKNOWN",
        decimals: Number(reserve.token.decimals),
        balance: reserve.balance,
        underlyingValue: reserve.underlyingValue,
        parentBond: reserve.bondAddress,
        maturityTimestamp: reserve.maturityTimestamp,
      })),
    };
  },
);

/** Compatibility view of the recorded Broker state; quotes stay recorded values. */
export const brokerDatasetSchema = brokerStateDatasetSchema.transform(
  (dataset) => ({
    ...compatibilityHeader(dataset.metadata),
    implementation: dataset.implementationAddress,
    implementationCodeHash: dataset.implementationCodeHash,
    state: {
      usdBalance: dataset.reserveState.usdBalance,
      perpBalance: dataset.reserveState.spotBalance,
      usdPrice: dataset.reserveState.usdPrice,
      perpPrice: dataset.reserveState.spotPrice,
    },
    assetRatio: dataset.assetRatio,
    standardQuotes: {
      usdInput: dataset.quotes.usdToSpot.inputAmount,
      perpOutput: dataset.quotes.usdToSpot.outputAmount,
      perpInput: dataset.quotes.spotToUsd.inputAmount,
      usdOutput: dataset.quotes.spotToUsd.outputAmount,
    },
  }),
);

export const decimalString = intStringSchema;
export const addressString = evmAddressSchema;
export const hashString = evmHashSchema;
export const isoUtcString = isoUtcTimestampSchema;

export type DatasetMetadata = z.infer<typeof metadataSchema>;
export type ContractReference = z.infer<typeof contractReferenceSchema>;
export type TokenDescriptor = z.infer<typeof tokenDescriptorSchema>;
export type AmplRebaseRow = z.infer<typeof amplRebaseRowSchema>;
export type AmplRebasesDataset = z.infer<typeof amplRebasesDatasetSchema>;
export type SpotReserve = z.infer<typeof spotReserveSchema>;
export type SpotHealthDataset = z.infer<typeof spotHealthDatasetSchema>;
export type BrokerQuote = z.infer<typeof brokerQuoteSchema>;
export type BrokerStateDataset = z.infer<typeof brokerStateDatasetSchema>;
export type BrokerQuoteGridDefinition = z.infer<
  typeof brokerQuoteGridDefinitionSchema
>;
export type LpRedemptionQuote = z.infer<typeof lpRedemptionQuoteSchema>;
export type BrokerQuotesDataset = z.infer<typeof brokerQuotesDatasetSchema>;
export type MetaDataset = z.infer<typeof metaDatasetSchema>;
export type ConformanceReport = z.infer<typeof conformanceReportSchema>;
export type AmplDataset = z.infer<typeof amplDatasetSchema>;
export type SpotDataset = z.infer<typeof spotDatasetSchema>;
export type BrokerDataset = z.infer<typeof brokerDatasetSchema>;
