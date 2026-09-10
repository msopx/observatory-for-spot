import type {
  BrokerQuote,
  BrokerQuotesDataset,
  LpRedemptionQuote,
} from "../data/schemas";
import { WAD } from "../protocol/fixed-point";

/**
 * Read-side helpers for the recorded Bill Broker quote grids. Nothing here
 * models the Broker: every function either selects recorded values or applies
 * the arithmetic stated in its comment to recorded values.
 */

export type QuoteDirection = "spot-to-usd" | "usd-to-spot";

export const QUOTE_DIRECTIONS: readonly QuoteDirection[] = [
  "spot-to-usd",
  "usd-to-spot",
];

export interface DirectionAssets {
  readonly inputSymbol: "SPOT" | "USDC";
  readonly outputSymbol: "SPOT" | "USDC";
  readonly inputDecimals: number;
  readonly outputDecimals: number;
}

export function directionAssets(
  dataset: BrokerQuotesDataset,
  direction: QuoteDirection,
): DirectionAssets {
  const usdDecimals = Number(dataset.usdToken.decimals);
  const spotDecimals = Number(dataset.spotToken.decimals);
  return direction === "spot-to-usd"
    ? {
        inputSymbol: "SPOT",
        outputSymbol: "USDC",
        inputDecimals: spotDecimals,
        outputDecimals: usdDecimals,
      }
    : {
        inputSymbol: "USDC",
        outputSymbol: "SPOT",
        inputDecimals: usdDecimals,
        outputDecimals: spotDecimals,
      };
}

function compareBigintStrings(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Quotes in ascending input size; the on-disk array order is canonical, not numeric. */
export function sortQuotesByInput(
  quotes: readonly BrokerQuote[],
): readonly BrokerQuote[] {
  return [...quotes].sort((left, right) =>
    compareBigintStrings(left.inputAmount, right.inputAmount),
  );
}

/** LP rows in ascending LP amount; the on-disk array order is canonical, not numeric. */
export function sortedLpRedemptions(
  dataset: BrokerQuotesDataset,
): readonly LpRedemptionQuote[] {
  return [...dataset.lpRedemptions].sort((left, right) =>
    compareBigintStrings(left.lpAmount, right.lpAmount),
  );
}

export function gridFor(
  dataset: BrokerQuotesDataset,
  direction: QuoteDirection,
): readonly BrokerQuote[] {
  return sortQuotesByInput(
    direction === "spot-to-usd" ? dataset.grid.spotToUsd : dataset.grid.usdToSpot,
  );
}

/** The recorded quote for exactly one whole input token, or null. */
export function oneUnitQuote(
  dataset: BrokerQuotesDataset,
  direction: QuoteDirection,
): BrokerQuote | null {
  const unit = (
    10n ** BigInt(directionAssets(dataset, direction).inputDecimals)
  ).toString();
  return gridFor(dataset, direction).find((quote) => quote.inputAmount === unit) ?? null;
}

/**
 * Output at equal value, before any fee, using only the recorded prices:
 * input × inputPrice × 10^outputDecimals / (outputPrice × 10^inputDecimals),
 * rounded down. This is a definition applied to recorded numbers, not a
 * protocol computation.
 */
export function equalValueOutput(
  dataset: BrokerQuotesDataset,
  direction: QuoteDirection,
  inputAmount: bigint,
): bigint {
  const usdDecimals = BigInt(dataset.usdToken.decimals);
  const spotDecimals = BigInt(dataset.spotToken.decimals);
  const usdPrice = BigInt(dataset.reserveState.usdPrice);
  const spotPrice = BigInt(dataset.reserveState.spotPrice);
  if (direction === "spot-to-usd") {
    return usdPrice === 0n
      ? 0n
      : (inputAmount * spotPrice * 10n ** usdDecimals) /
          (usdPrice * 10n ** spotDecimals);
  }
  return spotPrice === 0n
    ? 0n
    : (inputAmount * usdPrice * 10n ** spotDecimals) /
        (spotPrice * 10n ** usdDecimals);
}

export interface QuoteDerivation {
  readonly equalValueOutput: bigint;
  /**
   * (equalValueOutput − output) × 1e18 / equalValueOutput, truncated toward
   * zero. Positive means the recorded output is below equal value (a fee),
   * negative means above (a rebate). Null when the quote is unavailable or
   * the equal-value output is zero.
   */
  readonly impliedFeeWad: bigint | null;
}

export function deriveQuote(
  dataset: BrokerQuotesDataset,
  direction: QuoteDirection,
  quote: BrokerQuote,
): QuoteDerivation {
  const equal = equalValueOutput(dataset, direction, BigInt(quote.inputAmount));
  if (!quote.available || quote.outputAmount === null || equal === 0n) {
    return { equalValueOutput: equal, impliedFeeWad: null };
  }
  const output = BigInt(quote.outputAmount);
  return {
    equalValueOutput: equal,
    impliedFeeWad: ((equal - output) * WAD) / equal,
  };
}

/** Recorded output per one whole input token, 18-decimal fixed point, or null. */
export function averageOutputPerInputWad(
  quote: BrokerQuote,
  assets: DirectionAssets,
): bigint | null {
  if (!quote.available || quote.outputAmount === null) {
    return null;
  }
  const input = BigInt(quote.inputAmount);
  if (input === 0n) {
    return null;
  }
  return (
    (BigInt(quote.outputAmount) * 10n ** BigInt(assets.inputDecimals) * WAD) /
    (input * 10n ** BigInt(assets.outputDecimals))
  );
}

/** Percent string with the given fraction digits from an 18-decimal fraction. */
export function formatWadPercent(value: bigint, fractionDigits = 4): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scaled = magnitude * 100n;
  const whole = scaled / WAD;
  const fraction = ((scaled % WAD) * 10n ** BigInt(fractionDigits)) / WAD;
  return `${negative ? "-" : ""}${whole.toString()}.${fraction
    .toString()
    .padStart(fractionDigits, "0")}%`;
}

/** Total USDC from redeeming and selling all redeemed SPOT, or null. */
export function lpExitTotalUsd(redemption: LpRedemptionQuote): bigint | null {
  if (!redemption.available || redemption.usdOut === null) {
    return null;
  }
  if (redemption.sale === null) {
    return BigInt(redemption.usdOut);
  }
  if (!redemption.sale.available || redemption.sale.outputAmount === null) {
    return null;
  }
  return BigInt(redemption.usdOut) + BigInt(redemption.sale.outputAmount);
}

/** The recorded grid point whose input is closest to `target`, or null. */
export function nearestGridQuote(
  quotes: readonly BrokerQuote[],
  target: bigint,
): BrokerQuote | null {
  let best: BrokerQuote | null = null;
  let bestDistance: bigint | null = null;
  for (const quote of quotes) {
    const input = BigInt(quote.inputAmount);
    const distance = input > target ? input - target : target - input;
    if (bestDistance === null || distance < bestDistance) {
      best = quote;
      bestDistance = distance;
    }
  }
  return best;
}
