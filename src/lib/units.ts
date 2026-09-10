import { assertUint256, parseDecimalUnits } from "../protocol/fixed-point";

/** Parses a human decimal amount into positive base units or throws. */
export function parseTradeAmount(value: string, decimals: number): bigint {
  const amount = assertUint256(
    parseDecimalUnits(value, decimals),
    "trade amount",
  );
  if (amount === 0n) throw new Error("Enter an amount greater than zero.");
  return amount;
}
