import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  brokerQuotesDatasetSchema,
  brokerStateDatasetSchema,
} from "../src/data/schemas";
import {
  gridFor,
  oneUnitQuote,
  sortedLpRedemptions,
} from "../src/lib/recorded-quotes";

/**
 * Consistency of the committed recorded-quote dataset with the committed
 * Broker state. Both are eth_call outputs at the release block; this test
 * checks that they describe the same observation, not that any quote is
 * "correct": the contract is the only authority on that.
 */
describe("committed recorded Broker quotes", () => {
  it("record the same block, implementation and reserves as broker-state", async () => {
    const [quotes, state] = await Promise.all([
      readFile("public/data/broker-quotes.json", "utf8").then((text) =>
        brokerQuotesDatasetSchema.parse(JSON.parse(text) as unknown),
      ),
      readFile("public/data/broker-state.json", "utf8").then((text) =>
        brokerStateDatasetSchema.parse(JSON.parse(text) as unknown),
      ),
    ]);
    expect(quotes.metadata.status).toBe("release");
    expect(quotes.metadata.provenance.kind).toBe("ethereum-rpc");
    expect(quotes.metadata.blockNumber).toBe(state.metadata.blockNumber);
    expect(quotes.metadata.blockHash).toBe(state.metadata.blockHash);
    expect(quotes.implementationAddress).toBe(state.implementationAddress);
    expect(quotes.implementationCodeHash).toBe(state.implementationCodeHash);
    expect(quotes.reserveState).toEqual(state.reserveState);
    expect(quotes.lpDecimals).toBe(state.parameters.decimals);
    expect(quotes.burnFeePercent).toBe(state.parameters.fees.burnFeePercent);

    // The one-unit grid points are the standard quotes recorded in broker-state.
    expect(oneUnitQuote(quotes, "usd-to-spot")).toEqual(state.quotes.usdToSpot);
    expect(oneUnitQuote(quotes, "spot-to-usd")).toEqual(state.quotes.spotToUsd);

    // Grids follow the recorded definition: the smallest size is available, no
    // more than the maximum was recorded, and unavailable sizes form the tail.
    for (const direction of ["spot-to-usd", "usd-to-spot"] as const) {
      const grid = gridFor(quotes, direction);
      expect(grid.length).toBeLessThanOrEqual(
        quotes.grid.definition.maximumPoints,
      );
      expect(grid[0]?.available).toBe(true);
      const firstUnavailable = grid.findIndex((quote) => !quote.available);
      if (firstUnavailable !== -1) {
        expect(
          grid.slice(firstUnavailable).every((quote) => !quote.available),
        ).toBe(true);
      }
    }

    // Every chained sale was quoted against the reserves left after the redemption.
    for (const redemption of sortedLpRedemptions(quotes)) {
      if (!redemption.available || redemption.postWithdrawalReserves === null) {
        continue;
      }
      expect(
        BigInt(redemption.postWithdrawalReserves.usdBalance) +
          BigInt(redemption.usdOut!),
      ).toBe(BigInt(state.reserveState.usdBalance));
      expect(
        BigInt(redemption.postWithdrawalReserves.spotBalance) +
          BigInt(redemption.spotOut!),
      ).toBe(BigInt(state.reserveState.spotBalance));
      if (redemption.sale !== null) {
        expect(redemption.sale.inputAmount).toBe(redemption.spotOut);
      }
    }
  });
});
