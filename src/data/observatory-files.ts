import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  OBSERVATORY_FEEDS,
  observatoryDatasetSchema,
  observatoryManifestSchema,
  type FeedFailure,
  type ObservatoryDataset,
  type ObservatoryFeed,
  type ObservatoryFeedState,
  type ObservatoryManifest,
} from "./observatory-schemas";
import { assertPlaintextDataSafe, atomicWriteTextFile } from "./writers";
import {
  amplRebasesDatasetSchema,
  brokerStateDatasetSchema,
  spotHealthDatasetSchema,
} from "./schemas";

export interface FeedRefreshResult {
  feed: ObservatoryFeed;
  dataset?: ObservatoryDataset;
  failure?: FeedFailure;
  status?: "error" | "unsupported";
}

/** Keep temporal array order; the legacy serializer sorts arbitrary objects. */
export function observatoryJson(value: unknown): string {
  assertPlaintextDataSafe(value);
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return entry;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function unavailableFeed(
  attemptedAt: string,
  failure: FeedFailure = "no-verified-observations",
): ObservatoryFeedState {
  return {
    status: "unsupported",
    path: null,
    contentHash: null,
    observedAt: null,
    attemptedAt,
    message: failure,
    rowCount: 0,
    coverage: null,
  };
}

export async function readObservatoryManifest(
  directory: string,
): Promise<ObservatoryManifest | null> {
  try {
    return observatoryManifestSchema.parse(
      JSON.parse(
        await readFile(join(directory, "observatory-manifest.json"), "utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Existing observatory manifest failed validation");
  }
}

export async function readPublishedFeed(
  directory: string,
  state: ObservatoryFeedState,
): Promise<ObservatoryDataset | null> {
  if (state.path === null) return null;
  const contents = await readFile(
    join(directory, "observatory", basename(state.path)),
    "utf8",
  );
  if (
    createHash("sha256").update(contents).digest("hex") !== state.contentHash
  ) {
    throw new Error("Existing observatory feed failed integrity validation");
  }
  return observatoryDatasetSchema.parse(JSON.parse(contents));
}

function observationState(
  dataset: ObservatoryDataset,
): Pick<ObservatoryFeedState, "observedAt" | "coverage" | "rowCount"> {
  if (dataset.rows.length === 0)
    throw new Error("Refusing to publish an empty feed as available");
  const timestamps = dataset.rows.map((row) => row.timestamp).sort();
  if (dataset.feed === "spot-market") {
    const starts = dataset.rows.map((row) => BigInt(row.fromBlock));
    const ends = dataset.rows.map((row) => BigInt(row.toBlock));
    return {
      observedAt: timestamps.at(-1)!,
      coverage: {
        fromBlock: starts.reduce((a, b) => (a < b ? a : b)).toString(),
        toBlock: ends.reduce((a, b) => (a > b ? a : b)).toString(),
      },
      rowCount: dataset.rows.length,
    };
  }
  const blocks = dataset.rows
    .map((row) => ("blockNumber" in row ? BigInt(row.blockNumber) : 0n))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    observedAt: timestamps.at(-1)!,
    coverage: {
      fromBlock: blocks[0]!.toString(),
      toBlock: blocks.at(-1)!.toString(),
    },
    rowCount: dataset.rows.length,
  };
}

/** Publication runs under one exclusive filesystem lock per data directory. */
export async function withObservatoryRefreshLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, ".observatory-refresh-lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error("An observatory publication is already in progress");
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Immutable payloads are written first; one final rename publishes the manifest. */
export async function publishObservatoryRefresh(
  directory: string,
  attemptedAt: string,
  results: readonly FeedRefreshResult[],
  legacyDatasets: Partial<
    Record<"ampl-rebases" | "spot-health" | "broker-state", unknown>
  > = {},
): Promise<ObservatoryManifest> {
  return withObservatoryRefreshLock(directory, async () => {
    // Validate the whole batch before writing payloads so an unsupported
    // schema version never reaches the published directory.
    for (const result of results) {
      if (result.dataset !== undefined)
        observatoryDatasetSchema.parse(result.dataset);
    }
    const previous = await readObservatoryManifest(directory);
    const feeds = Object.fromEntries(
      OBSERVATORY_FEEDS.map((feed) => [
        feed,
        previous?.feeds[feed] ?? unavailableFeed(attemptedAt),
      ]),
    ) as ObservatoryManifest["feeds"];
    const seen = new Set<ObservatoryFeed>();
    for (const result of results) {
      if (seen.has(result.feed)) throw new Error("Duplicate feed result");
      seen.add(result.feed);
      if (result.dataset !== undefined) {
        const dataset = observatoryDatasetSchema.parse(result.dataset);
        if (dataset.feed !== result.feed)
          throw new Error("Refresh result identifies the wrong feed");
        const observations = observationState(dataset);
        const oldState = feeds[result.feed];
        if (
          (oldState.observedAt !== null &&
            observations.observedAt !== null &&
            observations.observedAt < oldState.observedAt) ||
          (oldState.coverage !== null &&
            observations.coverage !== null &&
            BigInt(observations.coverage.toBlock) <
              BigInt(oldState.coverage.toBlock))
        ) {
          feeds[result.feed] = {
            ...oldState,
            status: "error",
            message: "history-incomplete",
            attemptedAt:
              oldState.attemptedAt > attemptedAt
                ? oldState.attemptedAt
                : attemptedAt,
          };
          continue;
        }
        const contents = observatoryJson(dataset);
        const contentHash = createHash("sha256").update(contents).digest("hex");
        const filename = `${result.feed}.${contentHash}.json`;
        await atomicWriteTextFile(
          join(directory, "observatory", filename),
          contents,
        );
        feeds[result.feed] = {
          status: "ok",
          path: `/data/observatory/${filename}`,
          contentHash,
          attemptedAt,
          message: null,
          ...observations,
        };
      } else {
        // A failed refresh retains the previous immutable payload and observation date.
        feeds[result.feed] = {
          ...feeds[result.feed],
          attemptedAt,
          status: result.status ?? "error",
          message: result.failure ?? "read-failed",
        };
      }
    }
    const legacy = { ...previous?.legacy };
    const legacySchemas = {
      "ampl-rebases": amplRebasesDatasetSchema,
      "spot-health": spotHealthDatasetSchema,
      "broker-state": brokerStateDatasetSchema,
    };
    for (const key of [
      "ampl-rebases",
      "spot-health",
      "broker-state",
    ] as const) {
      if (legacyDatasets[key] === undefined) continue;
      const dataset = legacySchemas[key].parse(legacyDatasets[key]);
      if (dataset.metadata.provenance.kind !== "ethereum-rpc")
        throw new Error(
          "Only verified release datasets may update legacy feeds",
        );
      const oldReference = legacy[key];
      if (oldReference !== undefined) {
        const oldContents = await readFile(
          join(directory, "observatory", basename(oldReference.path)),
          "utf8",
        );
        if (
          createHash("sha256").update(oldContents).digest("hex") !==
          oldReference.contentHash
        )
          throw new Error("Legacy feed integrity validation failed");
        const oldDataset = legacySchemas[key].parse(JSON.parse(oldContents));
        if (
          BigInt(dataset.metadata.blockNumber) <
          BigInt(oldDataset.metadata.blockNumber)
        )
          continue;
        if (
          dataset.metadata.blockNumber === oldDataset.metadata.blockNumber &&
          dataset.metadata.blockHash !== oldDataset.metadata.blockHash
        )
          throw new Error("Legacy feed changed its block hash");
      }
      const contents = observatoryJson(dataset);
      const contentHash = createHash("sha256").update(contents).digest("hex");
      const filename = `legacy-${key}.${contentHash}.json`;
      await atomicWriteTextFile(
        join(directory, "observatory", filename),
        contents,
      );
      legacy[key] = { path: `/data/observatory/${filename}`, contentHash };
    }
    const generatedAt =
      previous !== null && previous.generatedAt > attemptedAt
        ? previous.generatedAt
        : attemptedAt;
    const manifest = observatoryManifestSchema.parse({
      schemaVersion: 1,
      generatedAt,
      feeds,
      legacy,
    });
    await atomicWriteTextFile(
      join(directory, "observatory-manifest.json"),
      observatoryJson(manifest),
    );
    return manifest;
  });
}
