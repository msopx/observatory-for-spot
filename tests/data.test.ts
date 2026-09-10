import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  amplDatasetSchema,
  brokerDatasetSchema,
  brokerQuotesDatasetSchema,
  spotDatasetSchema,
} from "../src/data/schemas";
import { stableJson } from "../src/data/files";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(resolve("public/data", name), { encoding: "utf8" }),
  );
}

describe("committed release datasets", () => {
  it("validates AMPL data and epoch ordering", async () => {
    const dataset = amplDatasetSchema.parse(
      await fixture("ampl-rebases.json"),
    );
    expect(dataset.status).toBe("release");
    expect(dataset.rows).toHaveLength(2_609);
    expect(dataset.rows[0]?.epoch).toBe("1");
    expect(dataset.rows.at(-1)?.epoch).toBe("2609");
    expect(dataset.rows.map((row) => BigInt(row.epoch))).toEqual(
      [...dataset.rows]
        .map((row) => BigInt(row.epoch))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  });

  it("validates SPOT, Broker state and recorded Broker quote datasets", async () => {
    expect(
      spotDatasetSchema.parse(await fixture("spot-health.json")).status,
    ).toBe("release");
    expect(
      brokerDatasetSchema.parse(await fixture("broker-state.json")).status,
    ).toBe("release");
    const quotes = brokerQuotesDatasetSchema.parse(
      await fixture("broker-quotes.json"),
    );
    expect(quotes.metadata.status).toBe("release");
    expect(quotes.grid.spotToUsd.length).toBeGreaterThan(0);
    expect(quotes.lpRedemptions.length).toBeGreaterThan(0);
  });

  it("serializes object keys deterministically", () => {
    expect(stableJson({ z: 1, a: { d: 2, b: 3 } })).toBe(
      '{\n  "a": {\n    "b": 3,\n    "d": 2\n  },\n  "z": 1\n}\n',
    );
  });
});
