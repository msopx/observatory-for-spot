import {
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";

import type { AmplRebaseRow } from "./schemas";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const SENSITIVE_KEYS = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "authorization",
  "credential",
  "credentials",
  "ethereum_rpc_url",
  "ethereumrpcurl",
  "mnemonic",
  "password",
  "private_key",
  "privatekey",
  "rpc_url",
  "rpcurl",
  "secret",
  "seed_phrase",
  "seedphrase",
]);

const PRIVATE_KEY_TEXT_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----/i;
const AUTHORITY_CREDENTIAL_PATTERN =
  /\bhttps?:\/\/[^/\s:@]+:[^@\s/]+@[^\s/]+/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeKey(key: string, path: string): void {
  const normalized = key.toLowerCase();
  if (SENSITIVE_KEYS.has(normalized)) {
    throw new Error(`Refusing to serialize sensitive field at ${path}`);
  }
}

function assertSafeString(value: string, path: string): void {
  if (
    PRIVATE_KEY_TEXT_PATTERN.test(value) ||
    AUTHORITY_CREDENTIAL_PATTERN.test(value)
  ) {
    throw new Error(`Refusing to serialize credential material at ${path}`);
  }
}

export function assertPlaintextDataSafe(
  value: unknown,
  path = "$",
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Non-finite number at ${path} is not valid JSON`);
    }
    return;
  }

  if (typeof value === "string") {
    assertSafeString(value, path);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertPlaintextDataSafe(entry, `${path}[${index}]`),
    );
    return;
  }

  if (!isPlainObject(value)) {
    throw new Error(`Unsupported non-plaintext value at ${path}`);
  }

  for (const [key, entry] of Object.entries(value)) {
    assertSafeKey(key, `${path}.${key}`);
    if (entry === undefined) {
      throw new Error(`Undefined is not valid JSON at ${path}.${key}`);
    }
    assertPlaintextDataSafe(entry, `${path}.${key}`);
  }
}

function compareIntegerStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function looksLikeAmplRow(value: unknown): value is AmplRebaseRow {
  if (!isPlainObject(value)) {
    return false;
  }
  return (
    typeof value.epoch === "string" &&
    typeof value.blockNumber === "string" &&
    typeof value.transactionHash === "string" &&
    typeof value.logIndex === "string" &&
    typeof value.tokenLogIndex === "string"
  );
}

export function compareAmplRebaseRows(
  left: AmplRebaseRow,
  right: AmplRebaseRow,
): number {
  const numericKeys: ReadonlyArray<
    "epoch" | "blockNumber" | "logIndex" | "tokenLogIndex"
  > = ["epoch", "blockNumber"];
  for (const key of numericKeys) {
    const compared = compareIntegerStrings(left[key], right[key]);
    if (compared !== 0) {
      return compared;
    }
  }

  const transactionCompared = compareText(
    left.transactionHash.toLowerCase(),
    right.transactionHash.toLowerCase(),
  );
  if (transactionCompared !== 0) {
    return transactionCompared;
  }

  for (const key of ["logIndex", "tokenLogIndex"] as const) {
    const compared = compareIntegerStrings(left[key], right[key]);
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}

function canonicalSortKey(value: JsonValue): string {
  return JSON.stringify(value);
}

/**
 * Recorded Broker quotes and LP redemptions carry one unsigned integer size
 * (`inputAmount` or `lpAmount`). Ordering them by that size keeps the written
 * grids readable in ascending trade size instead of by serialized text.
 */
function recordedSizeKey(value: unknown): bigint | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const size =
    typeof value.inputAmount === "string"
      ? value.inputAmount
      : typeof value.lpAmount === "string"
        ? value.lpAmount
        : null;
  return size !== null && /^(0|[1-9][0-9]*)$/.test(size) ? BigInt(size) : null;
}

function compareRecordedSizes(left: JsonValue, right: JsonValue): number {
  const leftSize = recordedSizeKey(left)!;
  const rightSize = recordedSizeKey(right)!;
  if (leftSize !== rightSize) {
    return leftSize < rightSize ? -1 : 1;
  }
  return compareText(canonicalSortKey(left), canonicalSortKey(right));
}

const CSV_KIND_ORDER = ["swap-quote", "lp-redemption"] as const;
const CSV_DIRECTION_ORDER = [
  "spot-to-usd",
  "usd-to-spot",
  "lp-to-usd-and-spot",
] as const;

function looksLikeRecordedQuoteCsvRow(
  value: unknown,
): value is Record<string, unknown> & {
  kind: string;
  direction: string;
  input_amount: string;
} {
  return (
    isPlainObject(value) &&
    typeof value.kind === "string" &&
    typeof value.direction === "string" &&
    typeof value.input_amount === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value.input_amount)
  );
}

function rank(order: readonly string[], value: string): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

function normalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => normalizeJson(entry));
    if (
      normalized.length > 1 &&
      normalized.every((entry) => isPlainObject(entry))
    ) {
      if (normalized.every((entry) => looksLikeAmplRow(entry))) {
        return [...normalized].sort((left, right) =>
          compareAmplRebaseRows(left, right),
        );
      }
      if (normalized.every((entry) => recordedSizeKey(entry) !== null)) {
        return [...normalized].sort(compareRecordedSizes);
      }
      return [...normalized].sort((left, right) =>
        compareText(canonicalSortKey(left), canonicalSortKey(right)),
      );
    }
    return normalized;
  }

  if (isPlainObject(value)) {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJson(value[key] as JsonValue);
    }
    return normalized;
  }

  return value;
}

export function stableJsonStringify(value: unknown): string {
  assertPlaintextDataSafe(value);
  return `${JSON.stringify(normalizeJson(value), null, 2)}\n`;
}

export interface CsvColumn<Row> {
  readonly header: string;
  readonly value: (row: Row) => boolean | null | number | string;
}

function csvEscape(value: boolean | null | number | string): string {
  if (value === null) {
    return "";
  }
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function compareCsvRows<Row extends object>(left: Row, right: Row): number {
  if (looksLikeAmplRow(left) && looksLikeAmplRow(right)) {
    return compareAmplRebaseRows(left, right);
  }
  if (looksLikeRecordedQuoteCsvRow(left) && looksLikeRecordedQuoteCsvRow(right)) {
    // Swap grids first, in direction order, each ascending by input size.
    const kind =
      rank(CSV_KIND_ORDER, left.kind) - rank(CSV_KIND_ORDER, right.kind);
    if (kind !== 0) {
      return kind;
    }
    const direction =
      rank(CSV_DIRECTION_ORDER, left.direction) -
      rank(CSV_DIRECTION_ORDER, right.direction);
    if (direction !== 0) {
      return direction;
    }
    const size = compareIntegerStrings(left.input_amount, right.input_amount);
    if (size !== 0) {
      return size;
    }
  }
  assertPlaintextDataSafe(left);
  assertPlaintextDataSafe(right);
  const leftKey = canonicalSortKey(normalizeJson(left));
  const rightKey = canonicalSortKey(normalizeJson(right));
  return compareText(leftKey, rightKey);
}

export function stableCsvStringify<Row extends object>(
  rows: readonly Row[],
  columns: readonly CsvColumn<Row>[],
): string {
  if (columns.length === 0) {
    throw new Error("CSV output requires at least one column");
  }
  const headers = new Set<string>();
  for (const column of columns) {
    if (column.header.length === 0 || headers.has(column.header)) {
      throw new Error("CSV headers must be non-empty and unique");
    }
    assertSafeKey(column.header, `$.columns.${column.header}`);
    headers.add(column.header);
  }

  rows.forEach((row) => assertPlaintextDataSafe(row));
  const sortedRows = [...rows].sort(compareCsvRows);
  const lines = [
    columns.map((column) => csvEscape(column.header)).join(","),
    ...sortedRows.map((row) =>
      columns.map((column) => csvEscape(column.value(row))).join(","),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export interface TextFileReplacement {
  readonly path: string;
  readonly contents: string;
}

function temporaryPath(destination: string): string {
  return join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.tmp`,
  );
}

function assertPlaintextDestination(path: string): void {
  const extension = extname(path).toLowerCase();
  if (extension !== ".json" && extension !== ".csv") {
    throw new Error("Atomic data output is limited to JSON and CSV files");
  }
}

export async function atomicWriteTextFiles(
  replacements: readonly TextFileReplacement[],
): Promise<void> {
  if (replacements.length === 0) {
    return;
  }

  const destinations = new Set<string>();
  const staged = replacements.map((replacement) => {
    assertPlaintextDestination(replacement.path);
    if (replacement.contents.includes("\0")) {
      throw new Error("Atomic data output cannot contain NUL bytes");
    }
    if (destinations.has(replacement.path)) {
      throw new Error(`Duplicate output destination: ${replacement.path}`);
    }
    destinations.add(replacement.path);
    return {
      ...replacement,
      temporaryPath: temporaryPath(replacement.path),
    };
  });

  try {
    await Promise.all(
      staged.map(async (replacement) => {
        await mkdir(dirname(replacement.path), { recursive: true });
        await writeFile(replacement.temporaryPath, replacement.contents, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o644,
        });
      }),
    );

    for (const replacement of staged) {
      await rename(replacement.temporaryPath, replacement.path);
    }
  } catch (error) {
    await Promise.all(
      staged.map((replacement) =>
        rm(replacement.temporaryPath, { force: true }).catch(() => undefined),
      ),
    );
    throw error;
  }
}

export async function atomicWriteTextFile(
  path: string,
  contents: string,
): Promise<void> {
  await atomicWriteTextFiles([{ path, contents }]);
}
