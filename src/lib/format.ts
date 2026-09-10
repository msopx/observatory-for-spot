import { formatUnitsExact } from "../protocol";

export function formatToken(
  value: string,
  decimals: number,
  maximumFractionDigits = 6,
): string {
  const exact = formatUnitsExact(BigInt(value), decimals);
  const [whole, fraction] = exact.split(".");
  if (!fraction) {
    return whole ?? "0";
  }
  return `${whole}.${fraction.slice(0, maximumFractionDigits)}`;
}

export function formatWad(
  value: string,
  maximumFractionDigits = 6,
): string {
  return formatToken(value, 18, maximumFractionDigits);
}

export function formatAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatUtcFromSeconds(value: string): string {
  return new Date(Number(BigInt(value) * 1000n)).toISOString();
}
