import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

import {
  mainnetImplementationVerifier,
  mainnetTargetRateResolver,
} from "../src/data/integration";
import {
  runRefresh,
  type ObservatoryPublicClient,
} from "../src/data/refresh";
import {
  amplRebasesDatasetSchema,
  brokerQuoteGridDefinitionSchema,
  brokerQuotesDatasetSchema,
  type BrokerQuoteGridDefinition,
} from "../src/data/schemas";
import { stableJsonStringify } from "../src/data/writers";
import { rateLimitedPublicClient } from "./rate-limited-client";

interface RefreshConfiguration {
  readonly schemaVersion: 1;
  readonly chainId: 1;
  readonly releaseBlock: {
    readonly number: string;
    readonly hash: `0x${string}`;
  };
  readonly generatedAt: string;
  readonly logRangeBlocks: string;
  readonly logResponseLimit: number;
  readonly brokerQuoteGrid: BrokerQuoteGridDefinition;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validatedUrl(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error(`${label} is not a public HTTPS endpoint`);
  }
  return value;
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

function parseConfiguration(value: unknown): RefreshConfiguration {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid release refresh configuration");
  }
  const config = value as RefreshConfiguration;
  if (
    config.schemaVersion !== 1 ||
    config.chainId !== 1 ||
    !/^[1-9]\d*$/.test(config.releaseBlock?.number ?? "") ||
    !/^0x[0-9a-fA-F]{64}$/.test(config.releaseBlock?.hash ?? "") ||
    !/^[1-9]\d*$/.test(config.logRangeBlocks ?? "") ||
    !Number.isSafeInteger(config.logResponseLimit) ||
    config.logResponseLimit <= 0 ||
    Number.isNaN(new Date(config.generatedAt).getTime()) ||
    !brokerQuoteGridDefinitionSchema.safeParse(config.brokerQuoteGrid).success
  ) {
    throw new Error("Invalid release refresh configuration");
  }
  return config;
}

async function main(): Promise<void> {
  const configText = await readFile("release/refresh-config.json", "utf8");
  const stateRpc = validatedUrl(
    process.env.ETHEREUM_RPC_URL,
    "ETHEREUM_RPC_URL",
  );
  const logRpc = validatedUrl(
    process.env.AMPL_LOG_RPC_URL ?? process.env.ETHEREUM_RPC_URL,
    "AMPL_LOG_RPC_URL",
  );
  const config = parseConfiguration(
    JSON.parse(configText) as unknown,
  );
  const intervalMs = requestInterval(process.env.RPC_REQUEST_INTERVAL_MS);
  const stateBaseClient = publicClient(stateRpc);
  const stateClient =
    intervalMs > 0
      ? rateLimitedPublicClient(stateBaseClient, intervalMs)
      : stateBaseClient;
  const logClient =
    stateRpc === logRpc
      ? stateClient
      : intervalMs > 0
        ? rateLimitedPublicClient(publicClient(logRpc), intervalMs)
        : publicClient(logRpc);
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "observatory-for-spot-release-data-"),
  );
  try {
    const result = await runRefresh({
      client: stateClient,
      logClient,
      releaseBlock: {
        number: BigInt(config.releaseBlock.number),
        expectedHash: config.releaseBlock.hash,
      },
      outputDirectory,
      targetRateResolver: mainnetTargetRateResolver,
      implementationVerifier: mainnetImplementationVerifier,
      now: () => new Date(config.generatedAt),
      initialLogRange: BigInt(config.logRangeBlocks),
      maximumLogRange: BigInt(config.logRangeBlocks),
      maximumLogsPerResponse: config.logResponseLimit,
      brokerQuoteGrid: config.brokerQuoteGrid,
    });
    const files = await Promise.all(
      result.files.map(async (name) => {
        const [expected, regenerated] = await Promise.all([
          readFile(join("public/data", name), "utf8"),
          readFile(join(outputDirectory, name), "utf8"),
        ]);
        if (regenerated !== expected) {
          throw new Error(`Regenerated release data differs: ${name}`);
        }
        return {
          name,
          bytes: Buffer.byteLength(expected),
          sha256: sha256(expected),
        };
      }),
    );
    const ampl = amplRebasesDatasetSchema.parse(
      JSON.parse(
        await readFile(
          join(outputDirectory, "ampl-rebases.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const epochs = ampl.rows.map((row) => BigInt(row.epoch));
    const firstEpoch = epochs[0];
    const lastEpoch = epochs.at(-1);
    if (firstEpoch === undefined || lastEpoch === undefined) {
      throw new Error("AMPL release history is empty");
    }
    const epochSet = new Set(epochs.map((epoch) => epoch.toString()));
    const absentEpochNumbers: string[] = [];
    for (let epoch = firstEpoch; epoch <= lastEpoch; epoch += 1n) {
      if (!epochSet.has(epoch.toString())) {
        absentEpochNumbers.push(epoch.toString());
      }
    }
    const brokerQuotes = brokerQuotesDatasetSchema.parse(
      JSON.parse(
        await readFile(
          join(outputDirectory, "broker-quotes.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const report = {
      schemaVersion: 1,
      report: "release-data-conformance",
      generatedAt: new Date().toISOString(),
      passed: true,
      releaseBlock: {
        number: result.releaseBlock.number.toString(),
        hash: result.releaseBlock.hash,
      },
      refreshConfigurationSha256: sha256(configText),
      files,
      amplCoverage: {
        rowCount: ampl.rows.length,
        firstEpoch: firstEpoch.toString(),
        lastEpoch: lastEpoch.toString(),
        absentEpochNumbers,
        duplicatePolicyAndTokenEmissions: "collapsed-only-when-identical",
      },
      brokerQuoteCoverage: {
        spotToUsdPoints: brokerQuotes.grid.spotToUsd.length,
        usdToSpotPoints: brokerQuotes.grid.usdToSpot.length,
        lpRedemptionPoints: brokerQuotes.lpRedemptions.length,
        unavailableSwapQuotes: [
          ...brokerQuotes.grid.spotToUsd,
          ...brokerQuotes.grid.usdToSpot,
        ].filter((quote) => !quote.available).length,
      },
      checks: [
        {
          id: "broker-quote-grid",
          status: "pass",
          message:
            "The recorded Bill Broker quote grids and LP redemption rows were reproduced by eth_call at the release block.",
        },
        {
          id: "byte-for-byte-data",
          status: "pass",
          message:
            "Every generated JSON and CSV file matches the committed release byte for byte.",
        },
        {
          id: "release-block",
          status: "pass",
          message:
            "The regenerated files use the configured mainnet block number and hash.",
        },
        {
          id: "ampl-event-coverage",
          status: "pass",
          message:
            "The full deployment-to-release event query reproduces the committed AMPL rows.",
        },
        {
          id: "implementation-identities",
          status: "pass",
          message:
            "SPOT, RolloverVault, FeePolicy, and Bill Broker runtime identities match the release registry.",
        },
      ],
    };
    await mkdir("artifacts", { recursive: true });
    await writeFile(
      "artifacts/release-data-conformance.json",
      stableJsonStringify(report),
      { encoding: "utf8", mode: 0o644 },
    );
    process.stdout.write(
      stableJsonStringify({
        status: "ok",
        releaseBlock: report.releaseBlock,
        files: files.length,
        amplRows: ampl.rows.length,
        absentEpochNumbers: absentEpochNumbers.length,
        brokerQuotePoints:
          brokerQuotes.grid.spotToUsd.length +
          brokerQuotes.grid.usdToSpot.length,
        lpRedemptionPoints: brokerQuotes.lpRedemptions.length,
      }),
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "release data verification failed"}\n`,
  );
  process.exitCode = 1;
});
