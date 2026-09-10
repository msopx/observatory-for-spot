// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Observatory for SPOT contributors.
/**
 * Checked integer and fixed-point arithmetic.
 *
 * JavaScript bigint division already truncates toward zero.  The explicit
 * helpers here make that rounding rule part of the public contract and add the
 * same bounds that apply to EVM uint256/int256 values.
 */

export const UINT256_MAX = (1n << 256n) - 1n;
export const INT256_MAX = (1n << 255n) - 1n;
export const INT256_MIN = -(1n << 255n);
export const WAD = 1_000_000_000_000_000_000n;

export class IntegerBoundsError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "IntegerBoundsError";
  }
}

export class DivisionByZeroError extends RangeError {
  constructor(operation: string) {
    super(`${operation}: denominator must not be zero`);
    this.name = "DivisionByZeroError";
  }
}

export function assertUint256(value: bigint, label = "value"): bigint {
  if (value < 0n || value > UINT256_MAX) {
    throw new IntegerBoundsError(`${label} is outside uint256 bounds`);
  }
  return value;
}

export function assertInt256(value: bigint, label = "value"): bigint {
  if (value < INT256_MIN || value > INT256_MAX) {
    throw new IntegerBoundsError(`${label} is outside int256 bounds`);
  }
  return value;
}

export function checkedAddUint256(a: bigint, b: bigint): bigint {
  assertUint256(a, "a");
  assertUint256(b, "b");
  return assertUint256(a + b, "uint256 addition result");
}

export function checkedSubUint256(a: bigint, b: bigint): bigint {
  assertUint256(a, "a");
  assertUint256(b, "b");
  if (b > a) {
    throw new IntegerBoundsError("uint256 subtraction underflow");
  }
  return a - b;
}

export function checkedMulUint256(a: bigint, b: bigint): bigint {
  assertUint256(a, "a");
  assertUint256(b, "b");
  return assertUint256(a * b, "uint256 multiplication result");
}

/**
 * Full-precision floor(a*b/denominator).
 *
 * The intermediate product is a JavaScript bigint and is intentionally not
 * restricted to 256 bits; only the operands and the final result are required
 * to fit uint256.
 */
export function mulDivDown(a: bigint, b: bigint, denominator: bigint): bigint {
  assertUint256(a, "a");
  assertUint256(b, "b");
  assertUint256(denominator, "denominator");
  if (denominator === 0n) {
    throw new DivisionByZeroError("mulDivDown");
  }
  return assertUint256((a * b) / denominator, "mulDivDown result");
}

/** Full-precision ceil(a*b/denominator). */
export function mulDivUp(a: bigint, b: bigint, denominator: bigint): bigint {
  assertUint256(a, "a");
  assertUint256(b, "b");
  assertUint256(denominator, "denominator");
  if (denominator === 0n) {
    throw new DivisionByZeroError("mulDivUp");
  }

  const product = a * b;
  const quotient = product / denominator;
  const result = product % denominator === 0n ? quotient : quotient + 1n;
  return assertUint256(result, "mulDivUp result");
}

/** Signed division with an explicit truncation-toward-zero contract. */
export function signedDivTowardZero(numerator: bigint, denominator: bigint): bigint {
  assertInt256(numerator, "numerator");
  assertInt256(denominator, "denominator");
  if (denominator === 0n) {
    throw new DivisionByZeroError("signedDivTowardZero");
  }
  if (numerator === INT256_MIN && denominator === -1n) {
    throw new IntegerBoundsError("signed division overflow");
  }
  return assertInt256(numerator / denominator, "signed division result");
}

/** Full-precision signed (a*b)/denominator, truncated toward zero. */
export function signedMulDivTowardZero(
  a: bigint,
  b: bigint,
  denominator: bigint,
): bigint {
  assertInt256(a, "a");
  assertInt256(b, "b");
  assertInt256(denominator, "denominator");
  if (denominator === 0n) {
    throw new DivisionByZeroError("signedMulDivTowardZero");
  }
  return assertInt256((a * b) / denominator, "signedMulDivTowardZero result");
}

export function pow10(decimals: bigint): bigint {
  if (decimals < 0n) {
    throw new IntegerBoundsError("decimals must not be negative");
  }
  return 10n ** decimals;
}

/**
 * Parses a base-ten decimal without passing through a JavaScript number.
 * Excess fractional precision is rejected rather than rounded.
 */
export function parseDecimal(value: string, decimals: bigint): bigint {
  if (decimals < 0n) {
    throw new IntegerBoundsError("decimals must not be negative");
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`invalid decimal string: ${value}`);
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const separator = unsigned.indexOf(".");
  const whole = separator === -1 ? unsigned : unsigned.slice(0, separator);
  const fraction = separator === -1 ? "" : unsigned.slice(separator + 1);

  if (BigInt(fraction.length) > decimals) {
    throw new RangeError("decimal string has more fractional digits than requested");
  }

  let paddedFraction = fraction;
  while (BigInt(paddedFraction.length) < decimals) {
    paddedFraction += "0";
  }

  const magnitude = BigInt(whole) * pow10(decimals) +
    (paddedFraction === "" ? 0n : BigInt(paddedFraction));
  return negative ? -magnitude : magnitude;
}

export interface FormatDecimalOptions {
  readonly trimTrailingZeros?: boolean;
  readonly minimumFractionDigits?: bigint;
}

/**
 * Formats an integer base-unit value without converting authoritative data to
 * Number. By default all requested decimal places are retained.
 */
export function formatDecimal(
  value: bigint,
  decimals: bigint,
  options: FormatDecimalOptions = {},
): string {
  if (decimals < 0n) {
    throw new IntegerBoundsError("decimals must not be negative");
  }
  const minimumFractionDigits = options.minimumFractionDigits ?? 0n;
  if (minimumFractionDigits < 0n || minimumFractionDigits > decimals) {
    throw new RangeError("minimumFractionDigits must be between zero and decimals");
  }

  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = pow10(decimals);
  const whole = magnitude / scale;
  let fraction = (magnitude % scale).toString();

  while (BigInt(fraction.length) < decimals) {
    fraction = `0${fraction}`;
  }

  if (options.trimTrailingZeros === true) {
    while (
      fraction.endsWith("0") &&
      BigInt(fraction.length) > minimumFractionDigits
    ) {
      fraction = fraction.slice(0, -1);
    }
  }

  const sign = negative ? "-" : "";
  return fraction === "" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

export const USDC_UNIT = 10n ** 6n;
export const SPOT_UNIT = 10n ** 9n;
export const MAX_UINT256 = UINT256_MAX;

export function divTowardZero(
  numerator: bigint,
  denominator: bigint,
): bigint {
  return signedDivTowardZero(numerator, denominator);
}

function decimalCount(decimals: bigint | number): bigint {
  if (typeof decimals === "bigint") {
    if (decimals < 0n) {
      throw new RangeError("decimals must be non-negative");
    }
    return decimals;
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    throw new RangeError("decimals must be a non-negative safe integer");
  }
  return BigInt(decimals);
}

/** Compatibility name for compact, exact base-unit formatting. */
export function formatUnitsExact(
  value: bigint,
  decimals: bigint | number,
): string {
  return formatDecimal(value, decimalCount(decimals), {
    trimTrailingZeros: true,
  });
}

/** Compatibility name for exact decimal parsing. */
export function parseDecimalUnits(
  value: string,
  decimals: bigint | number,
): bigint {
  return parseDecimal(value, decimalCount(decimals));
}
