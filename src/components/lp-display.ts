import type { Fraction } from "../analytics/lp";
import { fractionToWad } from "../analytics/lp";
import { usd } from "../lib/display";
import { formatUnitsExact } from "../protocol/fixed-point";

/** A useful illustrative position that fits every observation, without Number rounding. */
export function illustrativeLpNotes(supplies: readonly string[], decimals: string): string | null {
  const precision = BigInt(decimals);
  if (!supplies.length || precision < 0n || precision > 36n) return null;
  const minimum = supplies.map(BigInt).reduce((a, b) => a < b ? a : b);
  if (minimum <= 0n) return null;
  const onePercent = minimum / 100n;
  return formatUnitsExact(onePercent > 0n ? onePercent : 1n, precision);
}

/** Preserve the sign and significance of values below the normal dollar precision. */
export function lpDollars(value: Fraction): string {
  const magnitude = value.numerator < 0n ? -value.numerator : value.numerator;
  if (magnitude === 0n) return "$0";
  if (magnitude * 10_000n >= value.denominator) return `${value.numerator < 0n ? "-" : ""}${usd(fractionToWad({ numerator: magnitude, denominator: value.denominator }))}`;
  let exponent = magnitude.toString().length - value.denominator.toString().length;
  if (magnitude * 10n ** BigInt(-exponent) < value.denominator) exponent--;
  const significant = (magnitude * 10n ** BigInt(2 - exponent) / value.denominator).toString().padStart(3, "0");
  return `${value.numerator < 0n ? "-" : ""}$${significant[0]}.${significant.slice(1)}e${exponent}`;
}

/** Chart coordinates are approximate; exact fractions remain in reports. */
export function lpChartDollars(value: number): string {
  if (value === 0) return "$0";
  const magnitude = Math.abs(value);
  const amount = magnitude < 0.01
    ? magnitude.toExponential(2)
    : magnitude.toLocaleString("en-US", { maximumFractionDigits: magnitude < 1 ? 4 : 2 });
  return `${value < 0 ? "-" : ""}$${amount}`;
}
