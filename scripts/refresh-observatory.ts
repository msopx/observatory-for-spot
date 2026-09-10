import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

import {
  mainnetImplementationVerifier,
  mainnetTargetRateResolver,
} from "../src/data/integration";
import { bootstrapObservatory } from "../src/data/observatory-bootstrap";
import { verifySupportedBondRuntime } from "../src/data/observatory-bonds";
import {
  observatoryJson,
  publishObservatoryRefresh,
  readObservatoryManifest,
  readPublishedFeed,
  type FeedRefreshResult,
} from "../src/data/observatory-files";
import { readSpotMarketHistory } from "../src/data/observatory-market";
import {
  mergeAmplHistoryBaseline,
  runObservatoryRefresh,
  sampleDailyBlocks,
} from "../src/data/observatory-refresh";
import {
  OBSERVATORY_FEEDS,
  observatoryFeedSchema,
} from "../src/data/observatory-schemas";
import {
  parseReleaseBlockRequest,
  resolveReleaseBlock,
  type ObservatoryPublicClient,
} from "../src/data/refresh";
import {
  amplRebasesDatasetSchema,
  type AmplRebasesDataset,
} from "../src/data/schemas";
import { rateLimitedPublicClient } from "./rate-limited-client";

function rpcSetting(
  name: "ETHEREUM_RPC_URL" | "AMPL_LOG_RPC_URL",
  fallback?: string,
): string {
  const value = process.env[name] || fallback;
  if (value === undefined)
    throw new Error(`${name} is required for chain refresh`);
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
  } catch {
    throw new Error(`${name} is not a supported HTTP(S) endpoint`);
  }
  return value;
}
/**
 * Optional pacing for no-key public endpoints, with the same meaning as in the
 * release refresh: zero or unset disables it.
 */
function requestInterval(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 0;
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new Error("RPC_REQUEST_INTERVAL_MS must be a non-negative integer");
  const interval = Number(value);
  if (!Number.isSafeInteger(interval) || interval > 60_000)
    throw new Error("RPC_REQUEST_INTERVAL_MS exceeds the supported range");
  return interval;
}
function integerSetting(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const text = process.env[name];
  if (text === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(text))
    throw new Error("Refresh settings require positive integers");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > maximum)
    throw new Error("Refresh setting exceeds its supported maximum");
  return value;
}

/**
 * The packaged release baseline is complete for its range; the published feed
 * extends it. Merging the two with the baseline authoritative means a
 * published feed cannot carry gaps forward.
 */
async function previousAmpl(directory: string): Promise<AmplRebasesDataset> {
  const baseline = amplRebasesDatasetSchema.parse(
    JSON.parse(await readFile(resolve(directory, "ampl-rebases.json"), "utf8")),
  );
  const manifest = await readObservatoryManifest(directory);
  const feed =
    manifest === null
      ? null
      : await readPublishedFeed(directory, manifest.feeds["ampl-history"]);
  if (
    feed?.feed !== "ampl-history" ||
    feed.source !== "ethereum-rpc" ||
    feed.rows.length === 0
  )
    return baseline;
  return mergeAmplHistoryBaseline(baseline, feed);
}

export interface RefreshCommandDependencies {
  mode?: "--live" | "--bootstrap" | "--market-only";
  now?: () => Date;
  createClient?: (endpoint: string) => ObservatoryPublicClient;
  readMarket?: typeof readSpotMarketHistory;
}

export function observatoryOutputDirectory(
  cwd = process.cwd(),
  configured = process.env.OBSERVATORY_DATA_DIRECTORY,
): string {
  return resolve(cwd, configured || "public/data");
}

export async function main(
  dependencies: RefreshCommandDependencies = {},
): Promise<void> {
  const directory = observatoryOutputDirectory();
  const mode = dependencies.mode ?? process.argv[2] ?? "--live";
  const readMarket = dependencies.readMarket ?? readSpotMarketHistory;
  if (!["--live", "--bootstrap", "--market-only"].includes(mode))
    throw new Error("Use --live, --bootstrap, or --market-only");
  const now = (dependencies.now ?? (() => new Date()))();
  if (mode === "--bootstrap") {
    const manifest = await bootstrapObservatory(directory, now);
    process.stdout.write(
      observatoryJson({
        status: "ok",
        mode: "archived-bootstrap",
        feeds: Object.fromEntries(
          Object.entries(manifest.feeds).map(([feed, value]) => [
            feed,
            {
              status: value.status,
              rowCount: value.rowCount,
              observedAt: value.observedAt,
            },
          ]),
        ),
      }),
    );
    return;
  }
  const configuredFeeds = process.env.OBSERVATORY_FEEDS?.trim();
  const selectedFeeds =
    mode === "--market-only"
      ? ["spot-market" as const]
      : configuredFeeds === undefined || configuredFeeds === ""
        ? [...OBSERVATORY_FEEDS]
        : [
            ...new Set(
              configuredFeeds
                .split(",")
                .map((feed) => observatoryFeedSchema.parse(feed.trim())),
            ),
          ];
  let sourceReady = false;
  try {
    const rpcUrl = rpcSetting("ETHEREUM_RPC_URL");
    const logRpcUrl = rpcSetting("AMPL_LOG_RPC_URL", rpcUrl);
    const intervalMs = requestInterval(process.env.RPC_REQUEST_INTERVAL_MS);
    const baseCreateClient =
      dependencies.createClient ??
      ((endpoint: string) =>
        createPublicClient({
          chain: mainnet,
          transport: http(endpoint, { timeout: 25_000, retryCount: 1 }),
        }) as unknown as ObservatoryPublicClient);
    // One scheduler per endpoint: every feed's contract reads, block reads
    // and log queries share it, so parallel feeds cannot burst the endpoint.
    const createClient = (endpoint: string) =>
      intervalMs > 0
        ? rateLimitedPublicClient(baseCreateClient(endpoint), intervalMs)
        : baseCreateClient(endpoint);
    const client = createClient(rpcUrl);
    const logClient = rpcUrl === logRpcUrl ? client : createClient(logRpcUrl);
    const request = parseReleaseBlockRequest(
      process.env.RELEASE_BLOCK,
      process.env.RELEASE_BLOCK_HASH,
    );
    const release = await resolveReleaseBlock(client, request);
    sourceReady = true;
    if (mode === "--market-only") {
      const manifest = await readObservatoryManifest(directory);
      const previous =
        manifest === null
          ? null
          : await readPublishedFeed(directory, manifest.feeds["spot-market"]);
      const dataset = await readMarket({
        client,
        logClient,
        release,
        now,
        historyDays: integerSetting("OBSERVATORY_HISTORY_DAYS", 90, 365),
        previous: previous?.feed === "spot-market" ? previous : null,
      });
      const published = await publishObservatoryRefresh(
        directory,
        now.toISOString(),
        [{ feed: "spot-market", dataset }],
      );
      const state = published.feeds["spot-market"];
      const status = state.status === "ok" ? "ok" : "partial";
      process.stdout.write(
        observatoryJson({
          status,
          feed: "spot-market",
          rowCount: state.rowCount,
          observedAt: state.observedAt,
          message: state.message,
        }),
      );
      if (status !== "ok") process.exitCode = 1;
      return;
    }
    const days = integerSetting("OBSERVATORY_HISTORY_DAYS", 90, 365);
    const interval = integerSetting("OBSERVATORY_SAMPLE_INTERVAL_DAYS", 7, 365);
    const needsHistory = selectedFeeds.some((feed) =>
      ["spot-history", "broker-history", "stampl-history"].includes(feed),
    );
    process.stderr.write(
      observatoryJson({
        stage: "sampling",
        historyDays: days,
        sampleIntervalDays: interval,
      }),
    );
    const samples = needsHistory
      ? await sampleDailyBlocks(client, release, days, interval)
      : [release.number];
    process.stderr.write(
      observatoryJson({ stage: "reading-feeds", sampleCount: samples.length }),
    );
    const maximumLogRange = BigInt(
      integerSetting("AMPL_LOG_RANGE_BLOCKS", 10_000, 250_000),
    );
    const manifest = await runObservatoryRefresh({
      client,
      logClient,
      releaseBlock: request,
      sampleBlocks: samples,
      outputDirectory: directory,
      implementationVerifier: mainnetImplementationVerifier,
      targetRateResolver: mainnetTargetRateResolver,
      verifyBondRuntime: (input) =>
        verifySupportedBondRuntime({ client, ...input }),
      ...(selectedFeeds.includes("ampl-history")
        ? { previousAmpl: await previousAmpl(directory) }
        : {}),
      historyDays: days,
      marketReader: readMarket,
      feeds: selectedFeeds,
      now: () => now,
      onProgress: (event) =>
        process.stderr.write(observatoryJson({ stage: "feed", ...event })),
      initialLogRange: maximumLogRange,
      maximumLogRange,
      maximumLogsPerResponse: integerSetting(
        "AMPL_LOG_RESPONSE_LIMIT",
        10_000,
        1_000_000,
      ),
    });
    const status = selectedFeeds.every(
      (feed) => manifest.feeds[feed].status === "ok",
    )
      ? "ok"
      : "partial";
    process.stdout.write(
      observatoryJson({
        status,
        feeds: Object.fromEntries(
          Object.entries(manifest.feeds).map(([feed, value]) => [
            feed,
            {
              status: value.status,
              rowCount: value.rowCount,
              observedAt: value.observedAt,
              message: value.message,
            },
          ]),
        ),
      }),
    );
    if (status !== "ok") process.exitCode = 1;
  } catch {
    // This includes source/configuration failures before per-feed readers start,
    // and canonicality failures after collection. Never serialize the exception.
    const failures: FeedRefreshResult[] = selectedFeeds.map((feed) => ({
      feed,
      status: "error",
      failure:
        feed === "spot-market" && sourceReady
          ? "market-source-unavailable"
          : "rpc-unavailable",
    }));
    await publishObservatoryRefresh(directory, now.toISOString(), failures);
    throw new Error(
      "Chain refresh failed; feed failure states were recorded and previous observations retained",
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    // Raw RPC exceptions may contain credentials; never print their messages or causes.
    process.stderr.write(
      observatoryJson({
        status: "error",
        message:
          "Observatory refresh failed. Check required environment settings and source availability; existing published data was retained.",
      }),
    );
    process.exitCode = 1;
  });
}
