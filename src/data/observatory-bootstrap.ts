import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAINNET_DEPLOYMENTS,
  assertSupportedImplementation,
} from "../protocol/deployments";
import {
  publishObservatoryRefresh,
  type FeedRefreshResult,
} from "./observatory-files";
import {
  OBSERVATORY_FEEDS,
  observatoryDatasetSchema,
  type ObservatoryManifest,
} from "./observatory-schemas";
import {
  amplRebasesDatasetSchema,
  brokerStateDatasetSchema,
  spotHealthDatasetSchema,
} from "./schemas";

/** Repackage existing release observations; never fabricate missing history. */
export async function bootstrapObservatory(
  directory: string,
  now = new Date(),
): Promise<ObservatoryManifest> {
  const parseFile = async (name: string): Promise<unknown> =>
    JSON.parse(await readFile(join(directory, name), "utf8"));
  const [amplRaw, spotRaw, brokerRaw] = await Promise.all([
    parseFile("ampl-rebases.json"),
    parseFile("spot-health.json"),
    parseFile("broker-state.json"),
  ]);
  const ampl = amplRebasesDatasetSchema.parse(amplRaw);
  const spot = spotHealthDatasetSchema.parse(spotRaw);
  const broker = brokerStateDatasetSchema.parse(brokerRaw);
  for (const dataset of [ampl, spot, broker]) {
    if (
      dataset.metadata.provenance.kind !== "ethereum-rpc" ||
      dataset.metadata.blockTimestamp === null
    )
      throw new Error("Bootstrap requires the release datasets");
  }
  assertSupportedImplementation(
    MAINNET_DEPLOYMENTS.spot,
    BigInt(spot.metadata.blockNumber),
    spot.spot.implementationAddress as `0x${string}`,
    spot.spot.implementationCodeHash as `0x${string}`,
  );
  assertSupportedImplementation(
    MAINNET_DEPLOYMENTS.billBroker,
    BigInt(broker.metadata.blockNumber),
    broker.implementationAddress as `0x${string}`,
    broker.implementationCodeHash as `0x${string}`,
  );
  const generatedAt = now.toISOString();
  const envelope = {
    schemaVersion: 1,
    generatedAt,
    chainId: 1,
    source: "archived-release",
    notes: [
      "Repackaged from committed release data. Observation dates remain unchanged; this is not a fresh chain refresh.",
    ],
  };
  const results: FeedRefreshResult[] = [
    {
      feed: "ampl-history",
      dataset: observatoryDatasetSchema.parse({
        ...envelope,
        feed: "ampl-history",
        rows: ampl.rows,
      }),
    },
    {
      feed: "spot-history",
      dataset: observatoryDatasetSchema.parse({
        ...envelope,
        feed: "spot-history",
        rows: [
          {
            blockNumber: spot.metadata.blockNumber,
            blockHash: spot.metadata.blockHash,
            timestamp: spot.metadata.blockTimestamp,
            implementation: {
              address: spot.spot.implementationAddress,
              codeHash: spot.spot.implementationCodeHash,
            },
            collateralAmpl: spot.spot.collateralTvl,
            totalSupply: spot.spot.totalSupply,
            deviationRatio: spot.rolloverVault.deviationRatio,
            deviationRatioDecimals: spot.rolloverVault.deviationRatioDecimals,
            fmvUsd:
              broker.metadata.blockHash === spot.metadata.blockHash
                ? broker.reserveState.spotPrice
                : null,
            reserveCount: spot.reserves.length.toString(),
          },
        ],
      }),
    },
  ];
  for (const feed of OBSERVATORY_FEEDS) {
    if (
      feed !== "ampl-history" &&
      feed !== "spot-history" &&
      feed !== "spot-market"
    )
      results.push({ feed, status: "unsupported", failure: "rpc-unavailable" });
  }
  return publishObservatoryRefresh(directory, generatedAt, results);
}
