import type { AmplRebaseRow } from "../data/schemas";
export function filterRebases(
  rows: AmplRebaseRow[],
  from: string,
  to: string,
): AmplRebaseRow[] {
  return rows.filter(
    (row) =>
      (!from || row.timestamp.slice(0, 10) >= from) &&
      (!to || row.timestamp.slice(0, 10) <= to),
  );
}
/**
 * The policy emits the market oracle's value verbatim and skips the supply
 * adjustment when the oracle reports no valid rate, so a zero exchange rate
 * is that sentinel, not a price. Consumers must not plot or quote it as one.
 */
export function hasValidRate(row: AmplRebaseRow): boolean {
  return BigInt(row.exchangeRate) > 0n;
}
/** Newest row whose policy event carried a valid market rate, if any. */
export function latestValidRate(
  rows: AmplRebaseRow[],
): AmplRebaseRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (hasValidRate(row)) return row;
  }
  return undefined;
}
export function rebaseDirection(
  row: AmplRebaseRow,
): "expansion" | "contraction" | "neutral" | "unknown" {
  if (row.previousTotalSupply === null) return "unknown";
  const change = BigInt(row.totalSupply) - BigInt(row.previousTotalSupply);
  return change > 0n ? "expansion" : change < 0n ? "contraction" : "neutral";
}
export function rebaseSummary(rows: AmplRebaseRow[]) {
  const counts = { expansion: 0, contraction: 0, neutral: 0, unknown: 0 };
  let longestExpansion = 0,
    longestContraction = 0,
    run = 0,
    last = "unknown",
    priorEpoch: bigint | null = null;
  for (const row of rows) {
    const direction = rebaseDirection(row);
    counts[direction]++;
    const consecutive =
      priorEpoch !== null && BigInt(row.epoch) === priorEpoch + 1n;
    run = direction === last && consecutive ? run + 1 : 1;
    if (direction === "expansion")
      longestExpansion = Math.max(longestExpansion, run);
    if (direction === "contraction")
      longestContraction = Math.max(longestContraction, run);
    priorEpoch = BigInt(row.epoch);
    last = direction;
  }
  return {
    ...counts,
    longestExpansion,
    longestContraction,
    currentDirection: last,
    currentStreak: rows.length ? run : 0,
  };
}
export function monthCells(month: string): Array<string | null> {
  if (!/^\d{4}-\d{2}$/.test(month)) return [];
  const first = new Date(`${month}-01T00:00:00Z`);
  const count = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return [
    ...Array<null>(first.getUTCDay()).fill(null),
    ...Array.from(
      { length: count },
      (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
    ),
  ];
}
export function offsetMonth(month: string, amount: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 7);
}
export function recentRange(
  rows: AmplRebaseRow[],
  days: number,
): { from: string; to: string } {
  const end = rows.at(-1)?.timestamp.slice(0, 10) ?? "";
  if (!end) return { from: "", to: "" };
  const date = new Date(`${end}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days + 1);
  return { from: date.toISOString().slice(0, 10), to: end };
}
