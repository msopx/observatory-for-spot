import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPlaintextDataSafe,
  atomicWriteTextFile,
  atomicWriteTextFiles,
  stableCsvStringify,
  stableJsonStringify,
} from "../src/data/writers";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "observatory-for-spot-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("stable plaintext writers", () => {
  it("sorts keys, generic object arrays, and AMPL rows deterministically", () => {
    const first = stableJsonStringify({
      z: 1,
      objects: [{ id: "b" }, { id: "a" }],
      rows: [
        {
          epoch: "10",
          blockNumber: "20",
          transactionHash: `0x${"bb".repeat(32)}`,
          logIndex: "2",
          tokenLogIndex: "1",
        },
        {
          epoch: "2",
          blockNumber: "30",
          transactionHash: `0x${"aa".repeat(32)}`,
          logIndex: "2",
          tokenLogIndex: "1",
        },
      ],
      a: 2,
    });
    const second = stableJsonStringify({
      a: 2,
      rows: [
        {
          tokenLogIndex: "1",
          logIndex: "2",
          transactionHash: `0x${"aa".repeat(32)}`,
          blockNumber: "30",
          epoch: "2",
        },
        {
          tokenLogIndex: "1",
          logIndex: "2",
          transactionHash: `0x${"bb".repeat(32)}`,
          blockNumber: "20",
          epoch: "10",
        },
      ],
      objects: [{ id: "a" }, { id: "b" }],
      z: 1,
    });

    expect(first).toBe(second);
    const parsed = JSON.parse(first) as {
      rows: Array<{ epoch: string }>;
    };
    expect(parsed.rows.map((row) => row.epoch)).toEqual(["2", "10"]);
  });

  it("orders recorded quote grids and LP rows by input size rather than by serialized text", () => {
    const written = stableJsonStringify({
      grid: {
        spotToUsd: [
          { inputAmount: "10000000000", available: true },
          { inputAmount: "1000000000", available: true },
          { inputAmount: "31620000000000", available: false },
          { inputAmount: "1778000000", available: true },
        ],
      },
      lpRedemptions: [
        { lpAmount: "48579276852161797184448588123", available: true },
        { lpAmount: "1000000000000000000", available: true },
      ],
    });
    const parsed = JSON.parse(written) as {
      grid: { spotToUsd: Array<{ inputAmount: string }> };
      lpRedemptions: Array<{ lpAmount: string }>;
    };
    expect(parsed.grid.spotToUsd.map((quote) => quote.inputAmount)).toEqual([
      "1000000000",
      "1778000000",
      "10000000000",
      "31620000000000",
    ]);
    expect(parsed.lpRedemptions.map((row) => row.lpAmount)).toEqual([
      "1000000000000000000",
      "48579276852161797184448588123",
    ]);

    const csv = stableCsvStringify(
      [
        { kind: "lp-redemption", direction: "lp-to-usd-and-spot", input_amount: "5" },
        { kind: "swap-quote", direction: "usd-to-spot", input_amount: "1000000" },
        { kind: "swap-quote", direction: "spot-to-usd", input_amount: "10000000000" },
        { kind: "swap-quote", direction: "spot-to-usd", input_amount: "1000000000" },
      ],
      [
        { header: "kind", value: (row) => row.kind },
        { header: "direction", value: (row) => row.direction },
        { header: "input_amount", value: (row) => row.input_amount },
      ],
    );
    expect(csv).toBe(
      [
        "kind,direction,input_amount",
        "swap-quote,spot-to-usd,1000000000",
        "swap-quote,spot-to-usd,10000000000",
        "swap-quote,usd-to-spot,1000000",
        "lp-redemption,lp-to-usd-and-spot,5",
        "",
      ].join("\n"),
    );
  });

  it("writes deterministic RFC-style CSV with quoting", () => {
    const csv = stableCsvStringify(
      [
        { id: "2", note: "plain" },
        { id: "1", note: 'comma, quote "' },
      ],
      [
        { header: "id", value: (row) => row.id },
        { header: "note", value: (row) => row.note },
      ],
    );
    expect(csv).toBe(
      'id,note\n1,"comma, quote """\n2,plain\n',
    );
  });

  it("atomically replaces an existing plaintext data file", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "dataset.json");
    await writeFile(destination, '{"version":"old"}\n', "utf8");

    await atomicWriteTextFile(destination, '{"version":"new"}\n');

    await expect(readFile(destination, "utf8")).resolves.toBe(
      '{"version":"new"}\n',
    );
    expect(await readdir(directory)).toEqual(["dataset.json"]);
  });

  it("stages all files before replacing and rejects duplicate destinations", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "dataset.json");
    await writeFile(destination, '{"version":"old"}\n', "utf8");

    await expect(
      atomicWriteTextFiles([
        { path: destination, contents: '{"version":"one"}\n' },
        { path: destination, contents: '{"version":"two"}\n' },
      ]),
    ).rejects.toThrow("Duplicate output destination");
    await expect(readFile(destination, "utf8")).resolves.toBe(
      '{"version":"old"}\n',
    );
  });

  it("refuses sensitive fields and credential-bearing URLs", () => {
    expect(() =>
      stableJsonStringify({ ethereum_rpc_url: "https://rpc.invalid" }),
    ).toThrow("sensitive field");
    expect(() =>
      assertPlaintextDataSafe({
        source: "https://user:password@example.invalid/path",
      }),
    ).toThrow("credential material");
    expect(() => stableJsonStringify({ token: "SPOT" })).not.toThrow();
  });

  it("limits atomic output to plaintext JSON and CSV", async () => {
    const directory = await temporaryDirectory();
    await expect(
      atomicWriteTextFile(join(directory, "dataset.bin"), "not binary"),
    ).rejects.toThrow("limited to JSON and CSV");
  });
});
