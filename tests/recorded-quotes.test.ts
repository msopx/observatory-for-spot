import { describe, expect, it } from "vitest";

import {
  averageOutputPerInputWad,
  deriveQuote,
  directionAssets,
  equalValueOutput,
  formatWadPercent,
  gridFor,
  lpExitTotalUsd,
  nearestGridQuote,
  oneUnitQuote,
  sortedLpRedemptions,
} from "../src/lib/recorded-quotes";
import { parseTradeAmount } from "../src/lib/units";
import { recordedQuotesFixture } from "./fixtures/recorded-quotes";

describe("recorded quote derivations", () => {
  const dataset = recordedQuotesFixture();

  it("reads the grid in ascending size regardless of on-disk order", () => {
    expect(gridFor(dataset, "spot-to-usd")).toEqual(dataset.grid.spotToUsd);
    const shuffled = {
      ...dataset,
      grid: {
        ...dataset.grid,
        usdToSpot: [...dataset.grid.usdToSpot].reverse(),
      },
    };
    expect(gridFor(shuffled, "usd-to-spot")).toEqual(dataset.grid.usdToSpot);
    expect(oneUnitQuote(dataset, "usd-to-spot")?.inputAmount).toBe("1000000");
    expect(oneUnitQuote(dataset, "spot-to-usd")?.inputAmount).toBe(
      "1000000000",
    );
    expect(
      sortedLpRedemptions({
        ...dataset,
        lpRedemptions: [...dataset.lpRedemptions].reverse(),
      }).map((row) => row.lpAmount),
    ).toEqual(dataset.lpRedemptions.map((row) => row.lpAmount));
    expect(directionAssets(dataset, "spot-to-usd")).toEqual({
      inputSymbol: "SPOT",
      outputSymbol: "USDC",
      inputDecimals: 9,
      outputDecimals: 6,
    });
    expect(directionAssets(dataset, "usd-to-spot").outputDecimals).toBe(9);
  });

  it("derives equal-value output from the recorded prices only", () => {
    // 1 SPOT at $1.25 against USDC at $1.00 is 1.25 USDC = 1,250,000 base units.
    expect(equalValueOutput(dataset, "spot-to-usd", 1_000_000_000n)).toBe(
      1_250_000n,
    );
    // 1 USDC buys 0.8 SPOT = 800,000,000 base units.
    expect(equalValueOutput(dataset, "usd-to-spot", 1_000_000n)).toBe(
      800_000_000n,
    );
  });

  it("derives the implied fee as (equal - output) / equal and labels rebates negative", () => {
    const first = dataset.grid.spotToUsd[0]!;
    const derived = deriveQuote(dataset, "spot-to-usd", first);
    expect(derived.equalValueOutput).toBe(1_250_000n);
    // The fixture applies a 2% fee: (1,250,000 - 1,225,000) / 1,250,000.
    expect(derived.impliedFeeWad).toBe(20_000_000_000_000_000n);
    expect(formatWadPercent(derived.impliedFeeWad!)).toBe("2.0000%");
    expect(formatWadPercent(-15_000_000_000_000_000n, 2)).toBe("-1.50%");
    const unavailable = dataset.grid.spotToUsd.find((quote) => !quote.available);
    expect(unavailable).toBeDefined();
    expect(deriveQuote(dataset, "spot-to-usd", unavailable!).impliedFeeWad).toBe(
      null,
    );
  });

  it("reports recorded output per whole input token in 18-decimal fixed point", () => {
    const assets = directionAssets(dataset, "spot-to-usd");
    const first = dataset.grid.spotToUsd[0]!;
    // 1,225,000 USDC base units per 1e9 SPOT base units = 1.225 USDC per SPOT.
    expect(averageOutputPerInputWad(first, assets)).toBe(
      1_225_000_000_000_000_000n,
    );
    const unavailable = dataset.grid.spotToUsd.find((quote) => !quote.available)!;
    expect(averageOutputPerInputWad(unavailable, assets)).toBe(null);
  });

  it("sums recorded LP exits only when the recorded sale is available", () => {
    const small = dataset.lpRedemptions[0]!;
    expect(lpExitTotalUsd(small)).toBe(
      BigInt(small.usdOut!) + BigInt(small.sale!.outputAmount!),
    );
    const full = dataset.lpRedemptions.at(-1)!;
    // Redeeming all LP leaves no USDC to buy the redeemed SPOT.
    expect(full.sale?.available).toBe(false);
    expect(lpExitTotalUsd(full)).toBe(null);
  });

  it("selects the nearest recorded grid point and never interpolates", () => {
    const grid = dataset.grid.usdToSpot;
    expect(nearestGridQuote(grid, 4_000_000n)?.inputAmount).toBe("1000000");
    expect(nearestGridQuote(grid, 7_000_000n)?.inputAmount).toBe("10000000");
    expect(nearestGridQuote([], 1n)).toBe(null);
  });

  it("parses human amounts into positive base units", () => {
    expect(parseTradeAmount("1.5", 6)).toBe(1_500_000n);
    expect(() => parseTradeAmount("0", 6)).toThrow("greater than zero");
    expect(() => parseTradeAmount("1.0000001", 6)).toThrow();
  });
});
