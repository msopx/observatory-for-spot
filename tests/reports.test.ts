import { describe, expect, it } from "vitest";

import {
  RECORDED_QUOTE_CSV_COLUMNS,
  canonicalJson,
  csvCell,
  hashScenarioId,
  recordedQuoteContext,
  serializeRecordedQuotesCompanion,
  serializeRecordedQuotesCsv,
} from "../src/reports/report";
import { hashScenarioIdNode } from "../src/reports/node-hash";
import { recordedQuotesFixture } from "./fixtures/recorded-quotes";

describe("canonical JSON and scenario identifiers", () => {
  it("sorts keys, preserves arrays and encodes bigints as strings", () => {
    const first = canonicalJson({ z: 2n, a: { y: -1n, x: "ok" } });
    const second = canonicalJson({ a: { x: "ok", y: -1n }, z: 2n });
    expect(first).toBe('{"a":{"x":"ok","y":"-1"},"z":"2"}');
    expect(second).toBe(first);
    expect(() => canonicalJson({ unsafe: 1 })).toThrow(/number values/);
    expect(() => canonicalJson(new Date(0))).toThrow(/plain objects/);
  });

  it("produces matching Web Crypto and Node identifiers", async () => {
    const scenario = { amount: 12_345n, label: "SPOT → USDC" };
    await expect(hashScenarioId(scenario)).resolves.toBe(
      hashScenarioIdNode(scenario),
    );
  });

  it("quotes CSV cells only when they need it", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});

describe("recorded quote exports", () => {
  const dataset = recordedQuotesFixture();

  it("writes one row per recorded call with the observation identity on every row", () => {
    const csv = serializeRecordedQuotesCsv(dataset);
    const [header, ...rows] = csv.trimEnd().split("\n");
    expect(header).toBe(RECORDED_QUOTE_CSV_COLUMNS.join(","));
    expect(rows).toHaveLength(
      dataset.grid.spotToUsd.length +
        dataset.grid.usdToSpot.length +
        dataset.lpRedemptions.length,
    );
    const context = recordedQuoteContext(dataset);
    for (const row of rows) {
      const cells = row.split(",");
      expect(cells).toHaveLength(RECORDED_QUOTE_CSV_COLUMNS.length);
      expect(cells.slice(-8)).toEqual([
        "base-units",
        context.chainId,
        context.blockNumber,
        context.blockHash,
        context.blockTimestamp,
        context.brokerAddress,
        context.implementationAddress,
        context.implementationCodeHash,
      ]);
    }
    const first = rows[0]!.split(",");
    expect(first[RECORDED_QUOTE_CSV_COLUMNS.indexOf("kind")]).toBe("swap-quote");
    expect(first[RECORDED_QUOTE_CSV_COLUMNS.indexOf("direction")]).toBe(
      "spot-to-usd",
    );
    expect(first[RECORDED_QUOTE_CSV_COLUMNS.indexOf("outputAmount")]).toBe(
      dataset.grid.spotToUsd[0]!.outputAmount,
    );
    expect(
      first[RECORDED_QUOTE_CSV_COLUMNS.indexOf("derived_equalValueOutput")],
    ).toBe("1250000");
    expect(
      first[RECORDED_QUOTE_CSV_COLUMNS.indexOf("derived_impliedFeeWad")],
    ).toBe("20000000000000000");
    const lp = rows.at(-1)!.split(",");
    expect(lp[RECORDED_QUOTE_CSV_COLUMNS.indexOf("kind")]).toBe("lp-redemption");
    expect(lp[RECORDED_QUOTE_CSV_COLUMNS.indexOf("lpAmount")]).toBe(
      dataset.lpRedemptions.at(-1)!.lpAmount,
    );
    expect(lp[RECORDED_QUOTE_CSV_COLUMNS.indexOf("saleAvailable")]).toBe("false");
    expect(lp[RECORDED_QUOTE_CSV_COLUMNS.indexOf("derived_impliedFeeWad")]).toBe(
      "",
    );
  });

  it("honours a selection of directions and LP rows", () => {
    const onlyLp = serializeRecordedQuotesCsv(dataset, {
      directions: [],
      includeLpRedemptions: true,
    });
    expect(onlyLp.trimEnd().split("\n")).toHaveLength(
      1 + dataset.lpRedemptions.length,
    );
    const onlySpot = serializeRecordedQuotesCsv(dataset, {
      directions: ["spot-to-usd"],
      includeLpRedemptions: false,
    });
    expect(onlySpot.trimEnd().split("\n")).toHaveLength(
      1 + dataset.grid.spotToUsd.length,
    );
  });

  it("emits a canonical companion with context, prices, grid definition and units", () => {
    const text = serializeRecordedQuotesCompanion(dataset);
    const companion = JSON.parse(text) as {
      schema: string;
      context: { blockNumber: string };
      reserveState: { spotPrice: string };
      gridDefinition: {
        maximumPoints: string;
        stopAfterUnavailable: string;
        lpSupplyBasisPoints: string[];
      };
      columns: string[];
      units: { derived: string };
      notes: string[];
    };
    expect(companion.schema).toBe(
      "observatory-for-spot/recorded-broker-quotes-v1",
    );
    expect(companion.context.blockNumber).toBe("0");
    expect(companion.reserveState.spotPrice).toBe("1250000000000000000");
    expect(companion.gridDefinition.maximumPoints).toBe("5");
    expect(companion.gridDefinition.lpSupplyBasisPoints).toEqual([
      "10",
      "100",
      "10000",
    ]);
    expect(companion.columns).toEqual([...RECORDED_QUOTE_CSV_COLUMNS]);
    expect(companion.units.derived).toContain("not contract values");
    expect(companion.notes).toEqual(["Synthetic test data. Never published."]);
    // Canonical: re-serializing the parsed object with bigint counts reproduces the bytes.
    expect(text).toBe(
      canonicalJson({
        ...companion,
        gridDefinition: {
          ...companion.gridDefinition,
          maximumPoints: BigInt(companion.gridDefinition.maximumPoints),
          stopAfterUnavailable: BigInt(
            companion.gridDefinition.stopAfterUnavailable,
          ),
        },
      }),
    );
  });
});
