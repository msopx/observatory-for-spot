import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

import {
  mainnetImplementationVerifier,
  mainnetTargetRateResolver,
} from "../src/data/integration";
import {
  DEFAULT_BROKER_QUOTE_GRID,
  UnsupportedProtocolIntegrationError,
  parseReleaseBlockRequest,
  runRefresh,
  type ObservatoryPublicClient,
} from "../src/data/refresh";
import {
  brokerQuoteGridDefinitionSchema,
  isoUtcTimestampSchema,
  type BrokerQuoteGridDefinition,
} from "../src/data/schemas";
import { stableJsonStringify } from "../src/data/writers";
import { rateLimitedPublicClient } from "./rate-limited-client";

/**
 * The committed release data pins its generation timestamp so that a
 * regeneration reproduces the committed bytes. Set REFRESH_GENERATED_AT to the
 * `generatedAt` value in release/refresh-config.json for a release refresh;
 * leave it unset for an exploratory refresh stamped with the current time.
 */
function optionalGeneratedAt(value: string | undefined): (() => Date) | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const timestamp = isoUtcTimestampSchema.safeParse(value);
  if (!timestamp.success) {
    throw new Error("REFRESH_GENERATED_AT must be an ISO-8601 UTC timestamp");
  }
  return () => new Date(timestamp.data);
}

/** The grid definition in release/refresh-config.json, or the built-in default. */
async function configuredBrokerQuoteGrid(): Promise<BrokerQuoteGridDefinition> {
  try {
    const configuration = JSON.parse(
      await readFile("release/refresh-config.json", "utf8"),
    ) as { readonly brokerQuoteGrid?: unknown };
    if (configuration.brokerQuoteGrid === undefined) {
      return DEFAULT_BROKER_QUOTE_GRID;
    }
    return brokerQuoteGridDefinitionSchema.parse(configuration.brokerQuoteGrid);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return DEFAULT_BROKER_QUOTE_GRID;
    }
    throw error;
  }
}

function requiredRpcUrl(
  value: string | undefined,
  name = "ETHEREUM_RPC_URL",
): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error(
      `${name} must be an HTTP(S) URL without URL-embedded credentials`,
    );
  }
  return value;
}

function optionalLogRange(value: string | undefined): bigint | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("AMPL_LOG_RANGE_BLOCKS must be a positive integer");
  }
  return BigInt(value);
}

function optionalResponseLimit(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("AMPL_LOG_RESPONSE_LIMIT must be a positive integer");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new Error("AMPL_LOG_RESPONSE_LIMIT exceeds the safe integer range");
  }
  return limit;
}

function requestInterval(value: string | undefined): number {
  if (value === undefined || value.length === 0) {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error("RPC_REQUEST_INTERVAL_MS must be a non-negative integer");
  }
  const interval = Number(value);
  if (!Number.isSafeInteger(interval) || interval > 60_000) {
    throw new Error("RPC_REQUEST_INTERVAL_MS exceeds the supported range");
  }
  return interval;
}

function publicClient(url: string): ObservatoryPublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(url),
  }) as unknown as ObservatoryPublicClient;
}

export async function main(): Promise<void> {
  const rpcUrl = requiredRpcUrl(process.env.ETHEREUM_RPC_URL);
  const logRpcUrl =
    process.env.AMPL_LOG_RPC_URL === undefined ||
    process.env.AMPL_LOG_RPC_URL.length === 0
      ? rpcUrl
      : requiredRpcUrl(process.env.AMPL_LOG_RPC_URL, "AMPL_LOG_RPC_URL");
  const logRange = optionalLogRange(process.env.AMPL_LOG_RANGE_BLOCKS);
  const logResponseLimit = optionalResponseLimit(
    process.env.AMPL_LOG_RESPONSE_LIMIT,
  );
  const releaseBlock = parseReleaseBlockRequest(
    process.env.RELEASE_BLOCK,
    process.env.RELEASE_BLOCK_HASH,
  );
  const now = optionalGeneratedAt(process.env.REFRESH_GENERATED_AT);
  const brokerQuoteGrid = await configuredBrokerQuoteGrid();
  const intervalMs = requestInterval(process.env.RPC_REQUEST_INTERVAL_MS);
  const baseClient = publicClient(rpcUrl);
  const client =
    intervalMs > 0
      ? rateLimitedPublicClient(baseClient, intervalMs)
      : baseClient;
  const logClient =
    logRpcUrl === rpcUrl
      ? client
      : intervalMs > 0
        ? rateLimitedPublicClient(publicClient(logRpcUrl), intervalMs)
        : publicClient(logRpcUrl);

  const result = await runRefresh({
    client,
    logClient,
    releaseBlock,
    outputDirectory: resolve(process.cwd(), "public/data"),
    targetRateResolver: mainnetTargetRateResolver,
    implementationVerifier: mainnetImplementationVerifier,
    brokerQuoteGrid,
    ...(now === undefined ? {} : { now }),
    ...(logRange === undefined
      ? {}
      : { initialLogRange: logRange, maximumLogRange: logRange }),
    ...(logResponseLimit === undefined
      ? {}
      : { maximumLogsPerResponse: logResponseLimit }),
  });
  process.stdout.write(
    stableJsonStringify({
      status: "ok",
      chainId: 1,
      blockNumber: result.releaseBlock.number.toString(),
      blockHash: result.releaseBlock.hash,
      files: result.files,
    }),
  );
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof UnsupportedProtocolIntegrationError) {
    return error.message;
  }
  if (
    error instanceof Error &&
    /^(ETHEREUM_RPC_URL|AMPL_LOG_RPC_URL|RELEASE_BLOCK|REFRESH_GENERATED_AT|RPC_REQUEST_INTERVAL_MS|AMPL_LOG_(RANGE_BLOCKS|RESPONSE_LIMIT))/.test(
      error.message,
    )
  ) {
    return error.message;
  }
  return "Refresh failed while reading or validating Ethereum mainnet data.";
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      stableJsonStringify({
        status: "error",
        message: safeFailureMessage(error),
      }),
    );
    process.exitCode = 1;
  });
}
