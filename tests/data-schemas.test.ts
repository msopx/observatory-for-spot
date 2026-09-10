import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_FIXTURE_LABEL,
  amplRebasesDatasetSchema,
  brokerQuotesDatasetSchema,
  brokerStateDatasetSchema,
  decimalStringSchema,
  evmAddressSchema,
  evmHashSchema,
  isoUtcTimestampSchema,
  metaDatasetSchema,
  metadataSchema,
  spotHealthDatasetSchema,
  uintStringSchema,
} from "../src/data/schemas";
import { stableJsonStringify } from "../src/data/writers";
import { recordedQuotesFixture } from "./fixtures/recorded-quotes";

const datasets = [
  ["meta.json", metaDatasetSchema],
  ["ampl-rebases.json", amplRebasesDatasetSchema],
  ["spot-health.json", spotHealthDatasetSchema],
  ["broker-state.json", brokerStateDatasetSchema],
  ["broker-quotes.json", brokerQuotesDatasetSchema],
] as const;

async function readDataset(name: string): Promise<unknown> {
  const contents = await readFile(
    resolve(process.cwd(), "public/data", name),
    "utf8",
  );
  return JSON.parse(contents) as unknown;
}

describe("data schemas", () => {
  it.each(datasets)("accepts the committed dataset %s", async (name, schema) => {
    const dataset = await readDataset(name);
    expect(() => schema.parse(dataset)).not.toThrow();
  });

  it("requires canonical decimal-string EVM quantities", () => {
    expect(uintStringSchema.safeParse("0").success).toBe(true);
    expect(uintStringSchema.safeParse("12345678901234567890").success).toBe(
      true,
    );
    expect(uintStringSchema.safeParse(12).success).toBe(false);
    expect(uintStringSchema.safeParse("01").success).toBe(false);
    expect(uintStringSchema.safeParse("-1").success).toBe(false);
    expect(decimalStringSchema.safeParse("1.2500").success).toBe(true);
    expect(decimalStringSchema.safeParse("01.25").success).toBe(false);
  });

  it("validates EVM addresses, hashes, and real UTC timestamps", () => {
    expect(
      evmAddressSchema.safeParse(
        "0xD46bA6D942050d489DBd938a2C909A5d5039A161",
      ).success,
    ).toBe(true);
    expect(evmAddressSchema.safeParse("0x1234").success).toBe(false);
    expect(
      evmHashSchema.safeParse(`0x${"ab".repeat(32)}`).success,
    ).toBe(true);
    expect(evmHashSchema.safeParse("fixture:block:test").success).toBe(false);
    expect(
      isoUtcTimestampSchema.safeParse("2025-01-01T00:00:00.000Z").success,
    ).toBe(true);
    expect(
      isoUtcTimestampSchema.safeParse("2025-02-30T00:00:00.000Z").success,
    ).toBe(false);
    expect(
      isoUtcTimestampSchema.safeParse("2025-01-01T00:00:00+00:00").success,
    ).toBe(false);
  });

  it("does not permit a fixture hash to masquerade as RPC provenance", () => {
    const fixtureMetadata = {
      schemaVersion: 1,
      dataset: "meta",
      status: "fixture-not-final",
      generatedAt: "2026-08-28T00:00:00.000Z",
      chainId: 1,
      blockNumber: "0",
      blockHash: "fixture:block:test",
      blockTimestamp: null,
      provenance: {
        kind: "fixture",
        label: DEVELOPMENT_FIXTURE_LABEL,
        fixtureId: "test",
        generator: "test fixture",
        contracts: [],
        notes: [],
      },
    } as const;
    expect(metadataSchema.safeParse(fixtureMetadata).success).toBe(true);
    expect(
      metadataSchema.safeParse({
        ...fixtureMetadata,
        status: "release",
        blockNumber: "23000000",
        provenance: {
          kind: "ethereum-rpc",
          generator: "scripts/refresh.ts",
          contracts: [],
          notes: [],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects recorded-quote datasets whose grids or LP rows are inconsistent", () => {
    const valid = recordedQuotesFixture();
    expect(brokerQuotesDatasetSchema.safeParse(valid).success).toBe(true);

    const notOneUnit = structuredClone(valid);
    (notOneUnit.grid.spotToUsd[0] as { inputAmount: string }).inputAmount =
      "2000000000";
    expect(brokerQuotesDatasetSchema.safeParse(notOneUnit).success).toBe(false);

    const duplicated = structuredClone(valid);
    (duplicated.grid.usdToSpot[1] as { inputAmount: string }).inputAmount =
      "1000000";
    expect(brokerQuotesDatasetSchema.safeParse(duplicated).success).toBe(false);

    // Order is not a schema property: the writer stores arrays canonically.
    const reversed = structuredClone(valid);
    reversed.grid.spotToUsd.reverse();
    reversed.lpRedemptions.reverse();
    expect(brokerQuotesDatasetSchema.safeParse(reversed).success).toBe(true);

    const wrongReserves = structuredClone(valid);
    (
      wrongReserves.lpRedemptions[0] as {
        postWithdrawalReserves: { usdBalance: string };
      }
    ).postWithdrawalReserves.usdBalance = "1";
    expect(brokerQuotesDatasetSchema.safeParse(wrongReserves).success).toBe(
      false,
    );

    const saleMismatch = structuredClone(valid);
    (
      saleMismatch.lpRedemptions[0] as { sale: { inputAmount: string } }
    ).sale.inputAmount = "1";
    expect(brokerQuotesDatasetSchema.safeParse(saleMismatch).success).toBe(
      false,
    );

    const unavailableWithAmounts = structuredClone(valid);
    (
      unavailableWithAmounts.lpRedemptions[0] as { available: boolean }
    ).available = false;
    expect(
      brokerQuotesDatasetSchema.safeParse(unavailableWithAmounts).success,
    ).toBe(false);
  });

  it("marks every public dataset as release RPC provenance", async () => {
    for (const [name] of datasets) {
      const dataset = (await readDataset(name)) as {
        metadata: {
          status: string;
          provenance: { kind: string };
        };
      };
      expect(dataset.metadata.status).toBe("release");
      expect(dataset.metadata.provenance.kind).toBe("ethereum-rpc");
    }
  });

  it("stores every dataset in canonical deterministic JSON form", async () => {
    for (const [name] of datasets) {
      const path = resolve(process.cwd(), "public/data", name);
      const contents = await readFile(path, "utf8");
      expect(stableJsonStringify(JSON.parse(contents) as unknown)).toBe(
        contents,
      );
    }
  });

  it("rejects numeric quantities and the wrong fixed quote inputs", async () => {
    const broker = (await readDataset("broker-state.json")) as Record<
      string,
      unknown
    >;
    const numericQuantity = structuredClone(broker) as {
      reserveState: { usdBalance: unknown };
    };
    numericQuantity.reserveState.usdBalance = 1;
    expect(brokerStateDatasetSchema.safeParse(numericQuantity).success).toBe(
      false,
    );

    const wrongQuote = structuredClone(broker) as {
      quotes: { usdToSpot: { inputAmount: string } };
    };
    wrongQuote.quotes.usdToSpot.inputAmount = "999999";
    expect(brokerStateDatasetSchema.safeParse(wrongQuote).success).toBe(false);
  });
});
