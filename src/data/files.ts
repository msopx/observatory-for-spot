import {
  atomicWriteTextFile,
  stableCsvStringify,
  stableJsonStringify,
} from "./writers";

function stringifyBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(stringifyBigInts);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        stringifyBigInts(entry),
      ]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return stableJsonStringify(stringifyBigInts(value));
}

export async function writeAtomicText(
  destination: string,
  contents: string,
): Promise<void> {
  await atomicWriteTextFile(destination, contents);
}

export async function writeAtomicJson(
  destination: string,
  value: unknown,
): Promise<void> {
  await atomicWriteTextFile(destination, stableJson(value));
}

export function csv(
  headers: readonly string[],
  rows: readonly (readonly (bigint | null | number | string)[])[],
): string {
  if (rows.some((row) => row.length !== headers.length)) {
    throw new Error("CSV row width must match the header width");
  }
  const objectRows = rows.map((row) =>
    Object.fromEntries(
      headers.map((header, index) => {
        const value = row[index] ?? null;
        return [
          header,
          typeof value === "bigint" ? value.toString() : value,
        ];
      }),
    ),
  );
  return stableCsvStringify(
    objectRows,
    headers.map((header) => ({
      header,
      value: (row) => row[header] ?? null,
    })),
  );
}
