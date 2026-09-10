import type {
  BrokerQuote,
  BrokerQuotesDataset,
  LpRedemptionQuote,
} from "../data/schemas";
import {
  deriveQuote,
  gridFor,
  sortedLpRedemptions,
  type QuoteDirection,
} from "../lib/recorded-quotes";
import { sha256Hex } from "../lib/sha256";

export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | bigint
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export class CanonicalSerializationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalSerializationError";
  }
}

function serializeCanonical(
  value: unknown,
  ancestors: ReadonlySet<object>,
): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    throw new CanonicalSerializationError(
      "number values are forbidden; use bigint or a decimal string",
    );
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new CanonicalSerializationError(
      `unsupported canonical JSON value: ${typeof value}`,
    );
  }

  if (ancestors.has(value)) {
    throw new CanonicalSerializationError("cyclic values cannot be serialized");
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => serializeCanonical(entry, nextAncestors))
      .join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalSerializationError(
      "only arrays and plain objects are canonical JSON containers",
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonical(record[key], nextAncestors)}`,
    )
    .join(",")}}`;
}

/**
 * Canonical JSON uses lexicographically sorted object keys, preserves array
 * order, and serializes every bigint as an unambiguous base-ten string.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set<object>());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

function bytesToLowerHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

/**
 * Scenario IDs work on HTTP and HTTPS without Web Crypto. Explicitly injected
 * providers are still honored, including their failures.
 */
export async function hashScenarioId(
  scenario: unknown,
  cryptoProvider?: Pick<Crypto, "subtle">,
): Promise<string> {
  if (cryptoProvider === undefined) {
    return `sha256:${sha256Hex(canonicalJsonBytes(scenario))}`;
  }
  if (cryptoProvider?.subtle === undefined) {
    throw new Error("Web Crypto subtle.digest is unavailable");
  }
  const bytes = canonicalJsonBytes(scenario);
  const digest = await cryptoProvider.subtle.digest(
    "SHA-256",
    bytes.buffer as ArrayBuffer,
  );
  return `sha256:${bytesToLowerHex(new Uint8Array(digest))}`;
}

export function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/**
 * Observation identity that every exported row carries so that a file can be
 * read on its own: which deployed implementation answered the eth_call, at
 * which block, and in which units.
 */
export interface RecordedQuoteContext {
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  /** ISO-8601 UTC timestamp of the observation block, or "" when unknown. */
  readonly blockTimestamp: string;
  readonly brokerAddress: string;
  readonly implementationAddress: string;
  readonly implementationCodeHash: string;
}

export function recordedQuoteContext(
  dataset: BrokerQuotesDataset,
): RecordedQuoteContext {
  return {
    chainId: dataset.metadata.chainId.toString(),
    blockNumber: dataset.metadata.blockNumber,
    blockHash: dataset.metadata.blockHash,
    blockTimestamp: dataset.metadata.blockTimestamp ?? "",
    brokerAddress: dataset.brokerAddress,
    implementationAddress: dataset.implementationAddress,
    implementationCodeHash: dataset.implementationCodeHash,
  };
}

export const RECORDED_QUOTE_AMOUNT_UNIT_LABEL = "base-units";

/** Unit statements repeated in the companion of every export. */
export const RECORDED_QUOTE_UNITS = {
  amounts:
    "Token base units: USDC amounts have 6 decimals, SPOT amounts have 9 decimals, LP amounts use the Broker LP token decimals.",
  prices:
    "Recorded prices are 18-decimal fixed-point USD values (1e18 = $1.00).",
  derived:
    "derived_* columns are arithmetic on recorded values: equal-value output at the recorded prices, and (equalValue - output) / equalValue in 18-decimal fixed point. They are not contract values.",
  recorded:
    "All other numeric columns are eth_call results of the deployed Bill Broker at the stated block.",
} as const;

export const RECORDED_QUOTE_CSV_COLUMNS = [
  "kind",
  "direction",
  "inputAsset",
  "outputAsset",
  "inputAmount",
  "available",
  "outputAmount",
  "protocolFeeAmount",
  "unavailableReason",
  "derived_equalValueOutput",
  "derived_impliedFeeWad",
  "lpAmount",
  "usdOut",
  "spotOut",
  "postUsdBalance",
  "postSpotBalance",
  "saleAvailable",
  "saleOutputAmount",
  "saleProtocolFeeAmount",
  "saleUnavailableReason",
  "amountUnit",
  "chainId",
  "observationBlock",
  "observationBlockHash",
  "observationTimestamp",
  "brokerAddress",
  "implementationAddress",
  "implementationCodeHash",
] as const;

function contextCells(context: RecordedQuoteContext): readonly string[] {
  return [
    RECORDED_QUOTE_AMOUNT_UNIT_LABEL,
    context.chainId,
    context.blockNumber,
    context.blockHash,
    context.blockTimestamp,
    context.brokerAddress,
    context.implementationAddress,
    context.implementationCodeHash,
  ];
}

function swapRow(
  dataset: BrokerQuotesDataset,
  direction: QuoteDirection,
  quote: BrokerQuote,
  context: RecordedQuoteContext,
): readonly string[] {
  const derived = deriveQuote(dataset, direction, quote);
  return [
    "swap-quote",
    direction,
    quote.inputAsset,
    quote.outputAsset,
    quote.inputAmount,
    String(quote.available),
    quote.outputAmount ?? "",
    quote.protocolFeeAmount ?? "",
    quote.unavailableReason ?? "",
    derived.equalValueOutput.toString(),
    derived.impliedFeeWad?.toString() ?? "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ...contextCells(context),
  ];
}

function lpRow(
  dataset: BrokerQuotesDataset,
  redemption: LpRedemptionQuote,
  context: RecordedQuoteContext,
): readonly string[] {
  return [
    "lp-redemption",
    "lp-to-usd-and-spot",
    dataset.brokerAddress,
    "",
    redemption.lpAmount,
    String(redemption.available),
    "",
    "",
    redemption.unavailableReason ?? "",
    "",
    "",
    redemption.lpAmount,
    redemption.usdOut ?? "",
    redemption.spotOut ?? "",
    redemption.postWithdrawalReserves?.usdBalance ?? "",
    redemption.postWithdrawalReserves?.spotBalance ?? "",
    redemption.sale === null ? "" : String(redemption.sale.available),
    redemption.sale?.outputAmount ?? "",
    redemption.sale?.protocolFeeAmount ?? "",
    redemption.sale?.unavailableReason ?? "",
    ...contextCells(context),
  ];
}

export interface RecordedQuoteSelection {
  readonly directions?: readonly QuoteDirection[];
  readonly includeLpRedemptions?: boolean;
}

/**
 * Stable RFC-4180-compatible CSV of recorded quotes. Rows keep the dataset
 * order (ascending input size), values stay base-ten integer strings, and
 * every row carries the observation identity.
 */
export function serializeRecordedQuotesCsv(
  dataset: BrokerQuotesDataset,
  selection: RecordedQuoteSelection = {},
): string {
  const context = recordedQuoteContext(dataset);
  const directions = selection.directions ?? ["spot-to-usd", "usd-to-spot"];
  const rows: (readonly string[])[] = [];
  for (const direction of directions) {
    for (const quote of gridFor(dataset, direction)) {
      rows.push(swapRow(dataset, direction, quote, context));
    }
  }
  if (selection.includeLpRedemptions ?? true) {
    for (const redemption of sortedLpRedemptions(dataset)) {
      rows.push(lpRow(dataset, redemption, context));
    }
  }
  const lines = [
    RECORDED_QUOTE_CSV_COLUMNS.map(csvCell).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ];
  return `${lines.join("\n")}\n`;
}

export interface RecordedQuotesCompanion {
  readonly schema: "observatory-for-spot/recorded-broker-quotes-v1";
  readonly context: RecordedQuoteContext;
  readonly reserveState: BrokerQuotesDataset["reserveState"];
  readonly tokens: {
    readonly usd: BrokerQuotesDataset["usdToken"];
    readonly spot: BrokerQuotesDataset["spotToken"];
  };
  /** Counts are bigint because canonical JSON forbids numbers. */
  readonly gridDefinition: {
    readonly quarterDecadeMantissasThousandths: readonly string[];
    readonly maximumPoints: bigint;
    readonly stopAfterUnavailable: bigint;
    readonly lpSupplyBasisPoints: readonly string[];
  };
  readonly notes: readonly string[];
  readonly columns: readonly string[];
  readonly units: typeof RECORDED_QUOTE_UNITS;
}

/**
 * Companion to the CSV: the observation identity, the recorded reserve state
 * and prices the derivations use, the grid definition, the dataset's
 * provenance notes and the unit statements, as canonical JSON.
 */
export function serializeRecordedQuotesCompanion(
  dataset: BrokerQuotesDataset,
): string {
  const definition = dataset.grid.definition;
  const companion: RecordedQuotesCompanion = {
    schema: "observatory-for-spot/recorded-broker-quotes-v1",
    context: recordedQuoteContext(dataset),
    reserveState: dataset.reserveState,
    tokens: { usd: dataset.usdToken, spot: dataset.spotToken },
    gridDefinition: {
      quarterDecadeMantissasThousandths:
        definition.quarterDecadeMantissasThousandths,
      maximumPoints: BigInt(definition.maximumPoints),
      stopAfterUnavailable: BigInt(definition.stopAfterUnavailable),
      lpSupplyBasisPoints: definition.lpSupplyBasisPoints,
    },
    notes: dataset.metadata.provenance.notes,
    columns: [...RECORDED_QUOTE_CSV_COLUMNS],
    units: RECORDED_QUOTE_UNITS,
  };
  return canonicalJson(companion);
}
