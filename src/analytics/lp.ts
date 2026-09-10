import {
  SPOT_UNIT,
  USDC_UNIT,
  WAD,
  assertUint256,
} from "../protocol/fixed-point";

/** Exact fraction. Monetary calculations never pass through Number. */
export interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function fraction(numerator: bigint, denominator = 1n): Fraction {
  if (denominator === 0n)
    throw new RangeError("fraction denominator must not be zero");
  if (denominator < 0n) return fraction(-numerator, -denominator);
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

export function addFractions(a: Fraction, b: Fraction): Fraction {
  return fraction(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function subtractFractions(a: Fraction, b: Fraction): Fraction {
  return addFractions(a, {
    numerator: -b.numerator,
    denominator: b.denominator,
  });
}

export function scaleFraction(
  a: Fraction,
  numerator: bigint,
  denominator = 1n,
): Fraction {
  return fraction(a.numerator * numerator, a.denominator * denominator);
}

/** Truncates towards zero for display only; use the fraction for comparisons. */
export function fractionToWad(value: Fraction): bigint {
  return (value.numerator * WAD) / value.denominator;
}

export interface LpEndpoint {
  readonly blockNumber: bigint;
  /** Unix timestamp in seconds. */
  readonly timestamp: bigint;
  readonly usdc: bigint;
  readonly spot: bigint;
  readonly lpSupply: bigint;
  /** Protocol quote prices in USD WAD, not market prices. */
  readonly usdcPrice: bigint;
  readonly spotFmv: bigint;
}

export interface LpAssetClaim {
  /** Asset base units, retained as exact fractions. */
  readonly usdc: Fraction;
  readonly spot: Fraction;
}

export interface LpBenchmarkInput {
  readonly start: LpEndpoint;
  readonly end: LpEndpoint;
  /** A fixed number of existing LP notes, in LP base units. */
  readonly lpAmount: bigint;
}

export interface LpBenchmark {
  readonly model: "fixed-lp-notes-v1";
  readonly valuationBasis: "protocol-fmv-usd";
  readonly startClaim: LpAssetClaim;
  readonly endClaim: LpAssetClaim;
  /** USD, not WAD; fraction preserves all precision. */
  readonly startValue: Fraction;
  readonly endValue: Fraction;
  readonly holdingEndValue: Fraction;
  readonly valueChange: Fraction;
  readonly assetPriceEffect: Fraction;
  readonly inventoryAndFeeEffect: Fraction;
  readonly holdingPeriodReturn: Fraction | null;
  readonly holdingBasketReturn: Fraction | null;
  readonly excessReturn: Fraction | null;
  readonly elapsedSeconds: bigint;
}

function validateEndpoint(point: LpEndpoint): void {
  for (const [key, value] of Object.entries(point)) assertUint256(value, key);
  if (point.lpSupply === 0n) throw new RangeError("LP supply must be positive");
  if (point.usdcPrice === 0n || point.spotFmv === 0n)
    throw new RangeError("Both valuation prices must be positive and valid");
}

function claim(point: LpEndpoint, lpAmount: bigint): LpAssetClaim {
  return {
    usdc: fraction(point.usdc * lpAmount, point.lpSupply),
    spot: fraction(point.spot * lpAmount, point.lpSupply),
  };
}

function mark(assets: LpAssetClaim, point: LpEndpoint): Fraction {
  return addFractions(
    scaleFraction(assets.usdc, point.usdcPrice, USDC_UNIT * WAD),
    scaleFraction(assets.spot, point.spotFmv, SPOT_UNIT * WAD),
  );
}

function rate(change: Fraction, initial: Fraction): Fraction | null {
  return initial.numerator === 0n
    ? null
    : fraction(
        change.numerator * initial.denominator,
        change.denominator * initial.numerator,
      );
}

/**
 * Gross reserve ownership of existing notes; excludes entry/exit fees, gas,
 * reward programs and wallet cost basis. New deposits are normalized by supply.
 * This measures protocol-FMV marks, never executable exit proceeds.
 */
export function benchmarkLpNotes(input: LpBenchmarkInput): LpBenchmark {
  const { start, end, lpAmount } = input;
  validateEndpoint(start);
  validateEndpoint(end);
  assertUint256(lpAmount, "lpAmount");
  if (lpAmount === 0n) throw new RangeError("LP amount must be positive");
  if (lpAmount > start.lpSupply || lpAmount > end.lpSupply)
    throw new RangeError("Fixed notes cannot exceed either endpoint supply");
  if (end.blockNumber <= start.blockNumber || end.timestamp <= start.timestamp)
    throw new RangeError("LP endpoints must advance in both block and time");
  const startClaim = claim(start, lpAmount);
  const endClaim = claim(end, lpAmount);
  const startValue = mark(startClaim, start);
  const endValue = mark(endClaim, end);
  const holdingEndValue = mark(startClaim, end);
  const valueChange = subtractFractions(endValue, startValue);
  const assetPriceEffect = subtractFractions(holdingEndValue, startValue);
  const inventoryAndFeeEffect = subtractFractions(endValue, holdingEndValue);
  return {
    model: "fixed-lp-notes-v1",
    valuationBasis: "protocol-fmv-usd",
    startClaim,
    endClaim,
    startValue,
    endValue,
    holdingEndValue,
    valueChange,
    assetPriceEffect,
    inventoryAndFeeEffect,
    holdingPeriodReturn: rate(valueChange, startValue),
    holdingBasketReturn: rate(assetPriceEffect, startValue),
    excessReturn: rate(inventoryAndFeeEffect, startValue),
    elapsedSeconds: end.timestamp - start.timestamp,
  };
}

export interface LpLedgerEvent {
  readonly blockNumber: bigint;
  /** Block-global log index; events must be supplied in strict chain order. */
  readonly logIndex: bigint;
  readonly transactionHash: string;
  readonly kind: "swap" | "deposit" | "withdrawal" | "transfer" | "other";
  readonly usdcDelta: bigint;
  readonly spotDelta: bigint;
  readonly lpSupplyDelta: bigint;
  /** Swap fee in output asset base units, positive fee or negative rebate. */
  readonly fee: null | {
    readonly asset: "usdc" | "spot";
    readonly amount: bigint;
    readonly protocolAmount: bigint;
    readonly evidence: "transaction-verified";
  };
}

export interface LpFeeTotals {
  readonly positiveFees: bigint;
  readonly rebates: bigint;
  readonly protocolFees: bigint;
  readonly retainedNetFees: bigint;
}

/**
 * Reconcile actual transfer/supply deltas against endpoints. Deltas already
 * include protocol transfers; fee attribution is explanatory, not added twice.
 * The collector must coalesce transfers belonging to one economic event.
 */
export function reconcileLpLedger(input: {
  readonly start: LpEndpoint;
  readonly end: LpEndpoint;
  readonly events: readonly LpLedgerEvent[];
  readonly coverage: "complete" | "partial";
}) {
  validateEndpoint(input.start);
  validateEndpoint(input.end);
  if (input.end.blockNumber <= input.start.blockNumber)
    throw new RangeError("Ledger endpoints must advance");
  let previous: LpLedgerEvent | undefined;
  let usdc = input.start.usdc;
  let spot = input.start.spot;
  let lpSupply = input.start.lpSupply;
  let allSwapsAttributed = true;
  const fees = {
    usdc: {
      positiveFees: 0n,
      rebates: 0n,
      protocolFees: 0n,
      retainedNetFees: 0n,
    },
    spot: {
      positiveFees: 0n,
      rebates: 0n,
      protocolFees: 0n,
      retainedNetFees: 0n,
    },
  };
  for (const event of input.events) {
    assertUint256(event.blockNumber, "event block");
    assertUint256(event.logIndex, "event log index");
    if (!/^0x[0-9a-fA-F]{64}$/.test(event.transactionHash))
      throw new TypeError("Ledger transaction hash must be an EVM hash");
    if (
      event.blockNumber <= input.start.blockNumber ||
      event.blockNumber > input.end.blockNumber
    )
      throw new RangeError(
        "Event lies outside the open-start, closed-end interval",
      );
    if (
      previous &&
      (event.blockNumber < previous.blockNumber ||
        (event.blockNumber === previous.blockNumber &&
          event.logIndex <= previous.logIndex))
    )
      throw new RangeError("Ledger events must be unique and strictly ordered");
    previous = event;
    usdc += event.usdcDelta;
    spot += event.spotDelta;
    lpSupply += event.lpSupplyDelta;
    if (input.coverage === "complete") {
      assertUint256(usdc, "Complete ledger USDC reserve");
      assertUint256(spot, "Complete ledger SPOT reserve");
      assertUint256(lpSupply, "Complete ledger LP supply");
    }
    if (event.kind === "swap" && event.fee === null) allSwapsAttributed = false;
    if (event.fee !== null) {
      if (
        event.kind !== "swap" ||
        event.fee.evidence !== "transaction-verified"
      )
        throw new TypeError(
          "Swap fee attribution requires transaction verification",
        );
      const fee = event.fee;
      assertUint256(fee.protocolAmount, "protocol fee");
      if (fee.protocolAmount > (fee.amount > 0n ? fee.amount : 0n))
        throw new RangeError("Protocol fee cannot exceed a positive swap fee");
      const total = fees[fee.asset];
      if (fee.amount > 0n) total.positiveFees += fee.amount;
      else total.rebates -= fee.amount;
      total.protocolFees += fee.protocolAmount;
      total.retainedNetFees += fee.amount - fee.protocolAmount;
    }
  }
  const residual = {
    usdc: input.end.usdc - usdc,
    spot: input.end.spot - spot,
    lpSupply: input.end.lpSupply - lpSupply,
  };
  const reconciled =
    residual.usdc === 0n && residual.spot === 0n && residual.lpSupply === 0n;
  return {
    model: "broker-balance-ledger-v1" as const,
    status:
      input.coverage === "complete" && reconciled
        ? ("reconciled" as const)
        : ("incomplete" as const),
    residual,
    feeAttribution:
      input.coverage === "complete" && reconciled && allSwapsAttributed
        ? ("complete" as const)
        : ("partial" as const),
    fees,
  };
}
