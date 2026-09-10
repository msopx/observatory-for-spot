import { formatToken } from "./format";

/** Display only: financial calculations retain integer or rational precision. */
export function token(
  value: string | bigint,
  decimals: number,
  digits = 2,
): string {
  const raw = formatToken(value.toString(), decimals, digits);
  const [whole = "0", fraction] = raw.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction?.replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}
export function usd(value: string | bigint, decimals = 18, digits = 4): string {
  return `$${token(value, decimals, digits)}`;
}
export function dateLabel(value: string, includeTime = false): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(value));
}
export function downloadFile(
  filename: string,
  body: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function csv(rows: Array<Record<string, string | number | null>>) {
  const keys = Object.keys(rows[0] ?? {});
  const cell = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  return (
    [
      keys.map(cell).join(","),
      ...rows.map((row) => keys.map((key) => cell(row[key])).join(",")),
    ].join("\n") + "\n"
  );
}
