import { describe, expect, it } from "vitest";
import { SPOT_UNIT, USDC_UNIT, WAD } from "../src/protocol/fixed-point";
import {
  addFractions,
  benchmarkLpNotes,
  fraction,
  reconcileLpLedger,
  type LpEndpoint,
  type LpLedgerEvent,
} from "../src/analytics/lp";
import {
  createScenarioReport,
  importScenarioReport,
  replayAnalyticsScenario,
  serializeScenarioReport,
  type ScenarioProvenance,
} from "../src/analytics/scenarios";
import {
  brokerLpEndpoint,
  lpBenchmarkSeries,
  selectedBrokerLedger,
} from "../src/components/lp-model";
import {
  illustrativeLpNotes,
  lpChartDollars,
  lpDollars,
} from "../src/components/lp-display";
import type { BrokerHistoryPoint } from "../src/data/observatory-schemas";
import archivedBroker from "../public/data/broker-state.json";

const start: LpEndpoint = {
  blockNumber: 10n,
  timestamp: 1_000n,
  usdc: 100n * USDC_UNIT,
  spot: 25n * SPOT_UNIT,
  lpSupply: 100n,
  usdcPrice: WAD,
  spotFmv: 4n * WAD,
};
const end = { ...start, blockNumber: 20n, timestamp: 2_000n };

describe("fixed LP note benchmark", () => {
  it("does not count someone else's proportional deposit as a return", () => {
    const result = benchmarkLpNotes({
      start,
      end: {
        ...end,
        usdc: 200n * USDC_UNIT,
        spot: 50n * SPOT_UNIT,
        lpSupply: 200n,
      },
      lpAmount: 5n,
    });
    expect(result.startValue).toEqual(fraction(10n));
    expect(result.endValue).toEqual(fraction(10n));
    expect(result.holdingPeriodReturn).toEqual(fraction(0n));
    expect(result.startClaim).toEqual(result.endClaim);
  });

  it("uses the actual initial basket and separates price from inventory outcomes", () => {
    const result = benchmarkLpNotes({
      start,
      end: {
        ...end,
        usdc: 110n * USDC_UNIT,
        spot: 20n * SPOT_UNIT,
        spotFmv: 8n * WAD,
      },
      lpAmount: 10n,
    });
    expect(result.startValue).toEqual(fraction(20n));
    expect(result.holdingEndValue).toEqual(fraction(30n));
    expect(result.endValue).toEqual(fraction(27n));
    expect(result.assetPriceEffect).toEqual(fraction(10n));
    expect(result.inventoryAndFeeEffect).toEqual(fraction(-3n));
    expect(result.holdingPeriodReturn).toEqual(fraction(7n, 20n));
    expect(result.holdingBasketReturn).toEqual(fraction(1n, 2n));
    expect(result.excessReturn).toEqual(fraction(-3n, 20n));
    expect(
      addFractions(result.assetPriceEffect, result.inventoryAndFeeEffect),
    ).toEqual(result.valueChange);
    expect(result.valuationBasis).toBe("protocol-fmv-usd");
  });

  it("normalizes a proportional withdrawal and preserves fractions below one base unit", () => {
    const result = benchmarkLpNotes({
      start: { ...start, usdc: 3n, spot: 0n, lpSupply: 6n },
      end: { ...end, usdc: 2n, spot: 0n, lpSupply: 4n },
      lpAmount: 1n,
    });
    expect(result.startClaim.usdc).toEqual(fraction(1n, 2n));
    expect(result.endClaim.usdc).toEqual(fraction(1n, 2n));
    expect(result.startValue).toEqual(fraction(1n, 2_000_000n));
    expect(result.holdingPeriodReturn).toEqual(fraction(0n));
  });

  it("does not force a 50/50 benchmark or assume a dollar-valued USDC", () => {
    const result = benchmarkLpNotes({
      start: { ...start, spot: 0n },
      end: { ...end, spot: 0n, usdcPrice: (9n * WAD) / 10n },
      lpAmount: 1n,
    });
    expect(result.startValue).toEqual(fraction(1n));
    expect(result.endValue).toEqual(fraction(9n, 10n));
    expect(result.excessReturn).toEqual(fraction(0n));
  });

  it("rejects invalid prices, time order, zero or impossible ownership", () => {
    expect(() => benchmarkLpNotes({ start, end: start, lpAmount: 1n })).toThrow(
      /advance/,
    );
    expect(() => benchmarkLpNotes({ start, end, lpAmount: 101n })).toThrow(
      /exceed/,
    );
    expect(() => benchmarkLpNotes({ start, end, lpAmount: 0n })).toThrow(
      /positive/,
    );
    expect(() =>
      benchmarkLpNotes({ start, end: { ...end, lpSupply: 0n }, lpAmount: 1n }),
    ).toThrow(/supply/);
    expect(() =>
      benchmarkLpNotes({ start, end: { ...end, spotFmv: 0n }, lpAmount: 1n }),
    ).toThrow(/prices/);
  });

  it("returns no percentage if the starting reserve basket is worthless", () => {
    const result = benchmarkLpNotes({
      start: { ...start, usdc: 0n, spot: 0n },
      end,
      lpAmount: 1n,
    });
    expect(result.holdingPeriodReturn).toBeNull();
    expect(result.excessReturn).toBeNull();
  });
});

const tx = `0x${"a".repeat(64)}`;
const swap: LpLedgerEvent = {
  blockNumber: 11n,
  logIndex: 1n,
  transactionHash: tx,
  kind: "swap",
  usdcDelta: -9n * USDC_UNIT,
  spotDelta: 3n * SPOT_UNIT,
  lpSupplyDelta: 0n,
  fee: {
    asset: "usdc",
    amount: 2n * USDC_UNIT,
    protocolAmount: USDC_UNIT,
    evidence: "transaction-verified",
  },
};

describe("LP reserve and fee reconciliation", () => {
  it("separates positive fees, rebates and protocol share without adding them twice", () => {
    const rebate: LpLedgerEvent = {
      ...swap,
      blockNumber: 12n,
      usdcDelta: 7n * USDC_UNIT,
      spotDelta: -2n * SPOT_UNIT,
      fee: {
        asset: "spot",
        amount: -SPOT_UNIT / 4n,
        protocolAmount: 0n,
        evidence: "transaction-verified",
      },
    };
    const result = reconcileLpLedger({
      start,
      end: { ...end, usdc: 98n * USDC_UNIT, spot: 26n * SPOT_UNIT },
      events: [swap, rebate],
      coverage: "complete",
    });
    expect(result.status).toBe("reconciled");
    expect(result.feeAttribution).toBe("complete");
    expect(result.fees.usdc).toEqual({
      positiveFees: 2n * USDC_UNIT,
      rebates: 0n,
      protocolFees: USDC_UNIT,
      retainedNetFees: USDC_UNIT,
    });
    expect(result.fees.spot).toEqual({
      positiveFees: 0n,
      rebates: SPOT_UNIT / 4n,
      protocolFees: 0n,
      retainedNetFees: -SPOT_UNIT / 4n,
    });
    expect(result.residual).toEqual({ usdc: 0n, spot: 0n, lpSupply: 0n });
  });

  it("reconciles deposits and minted supply without labeling deposited assets as fees", () => {
    const deposit: LpLedgerEvent = {
      ...swap,
      kind: "deposit",
      usdcDelta: start.usdc,
      spotDelta: start.spot,
      lpSupplyDelta: start.lpSupply,
      fee: null,
    };
    const result = reconcileLpLedger({
      start,
      end: {
        ...end,
        usdc: 2n * start.usdc,
        spot: 2n * start.spot,
        lpSupply: 2n * start.lpSupply,
      },
      events: [deposit],
      coverage: "complete",
    });
    expect(result.status).toBe("reconciled");
    expect(result.fees.usdc.positiveFees).toBe(0n);
  });

  it("exposes unexplained transfers and missed supply changes as residuals", () => {
    const result = reconcileLpLedger({
      start,
      end: { ...end, usdc: 101n * USDC_UNIT, lpSupply: 105n },
      events: [],
      coverage: "complete",
    });
    expect(result.status).toBe("incomplete");
    expect(result.residual).toEqual({
      usdc: USDC_UNIT,
      spot: 0n,
      lpSupply: 5n,
    });
    expect(result.feeAttribution).toBe("partial");
  });

  it("does not infer complete coverage merely from zero endpoint residuals", () => {
    expect(
      reconcileLpLedger({ start, end, events: [], coverage: "partial" }).status,
    ).toBe("incomplete");
    const result = reconcileLpLedger({
      start,
      end: { ...end, usdc: 91n * USDC_UNIT, spot: 28n * SPOT_UNIT },
      events: [{ ...swap, fee: null }],
      coverage: "complete",
    });
    expect(result.status).toBe("reconciled");
    expect(result.feeAttribution).toBe("partial");
  });

  it("rejects duplicate/out-of-window events and protocol fees on rebates", () => {
    expect(() =>
      reconcileLpLedger({
        start,
        end,
        events: [swap, swap],
        coverage: "complete",
      }),
    ).toThrow(/unique/);
    expect(() =>
      reconcileLpLedger({
        start,
        end,
        events: [{ ...swap, blockNumber: start.blockNumber }],
        coverage: "complete",
      }),
    ).toThrow(/outside/);
    expect(() =>
      reconcileLpLedger({
        start,
        end,
        events: [
          {
            ...swap,
            fee: {
              asset: "usdc",
              amount: -1n,
              protocolAmount: 1n,
              evidence: "transaction-verified",
            },
          },
        ],
        coverage: "complete",
      }),
    ).toThrow(/positive/);
  });
});

const provenance: ScenarioProvenance = {
  chainId: "1",
  observations: [
    {
      blockNumber: "25853823",
      blockHash:
        "0xb716fb7135252cdc4cc58ed16066b65d47328308e61a196cde827f813e95c54d",
      timestamp: "2026-08-28T12:45:11.000Z",
      contracts: [
        {
          address: "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB",
          implementationAddress: "0x9Ce5056eEEd22e4569a39DAa670bacD277df3ef1",
          runtimeCodeHash:
            "0x2005b63859f224931e9336ab2fb012c7edc4304deaa0c9d5bb59378ae63dfb3e",
          interfaceVersion: "bill-broker-v5-factor",
        },
      ],
    },
  ],
  datasets: [{ name: "synthetic-test", sha256: `sha256:${"0".repeat(64)}` }],
};

describe("complete scenario reports", () => {
  it("reproduces a complete signed transfer ledger without losing fee precision", async () => {
    const inputs = {
      start,
      end: { ...end, usdc: 91n * USDC_UNIT, spot: 28n * SPOT_UNIT },
      events: [swap],
      coverage: "complete" as const,
    };
    const report = await createScenarioReport({
      modelVersion: "broker-balance-ledger-v1",
      provenance,
      assumptions: ["Synthetic transfers."],
      inputs,
      expectedOutputs: reconcileLpLedger(inputs),
    });
    expect(
      (
        await replayAnalyticsScenario(
          await importScenarioReport(serializeScenarioReport(report)),
        )
      ).matchesExpected,
    ).toBe(true);
  });
  it("roundtrips inputs above Number precision and independently reproduces outputs", async () => {
    const inputs = {
      start: { ...start, lpSupply: 10n ** 24n },
      end: { ...end, lpSupply: 10n ** 24n },
      lpAmount: 9_007_199_254_740_993n,
    };
    const report = await createScenarioReport({
      modelVersion: "fixed-lp-notes-v1",
      provenance,
      assumptions: [
        "Synthetic test inputs; protocol-FMV marks; no execution costs.",
      ],
      inputs,
      expectedOutputs: benchmarkLpNotes(inputs),
    });
    const serialized = serializeScenarioReport(report);
    expect(serialized).toContain('"9007199254740993"');
    const imported = await importScenarioReport(serialized);
    const replay = await replayAnalyticsScenario(imported);
    expect(replay.matchesExpected).toBe(true);
    expect(replay.provenanceVerification).toBe("not-verified");
    expect(serializeScenarioReport(imported)).toBe(serialized);
  });

  it("rejects tampering and detects a self-consistent hash with wrong expected results", async () => {
    const inputs = { start, end, lpAmount: 1n };
    const report = await createScenarioReport({
      modelVersion: "fixed-lp-notes-v1",
      provenance,
      assumptions: ["Synthetic."],
      inputs,
      expectedOutputs: { wrong: "1" },
    });
    const serialized = serializeScenarioReport(report);
    await expect(
      importScenarioReport(
        serialized.replace('"lpAmount":"1"', '"lpAmount":"2"'),
      ),
    ).rejects.toThrow(/does not match its identifier/);
    expect((await replayAnalyticsScenario(report)).matchesExpected).toBe(false);
  });

  it("rejects unknown fields, model versions, missing evidence and unsafe numeric inputs", async () => {
    const inputs = { start, end, lpAmount: 1n };
    await expect(
      createScenarioReport({
        modelVersion: "fixed-lp-notes-v1",
        provenance,
        assumptions: ["Synthetic."],
        inputs: { amount: 1 },
        expectedOutputs: null,
      }),
    ).rejects.toThrow(/number/);
    await expect(
      createScenarioReport({
        modelVersion: "fixed-lp-notes-v1",
        provenance: { ...provenance, datasets: [] },
        assumptions: ["Synthetic."],
        inputs,
        expectedOutputs: null,
      }),
    ).rejects.toThrow();
    const unknown = await createScenarioReport({
      modelVersion: "fixed-lp-notes-v2",
      provenance,
      assumptions: ["Synthetic."],
      inputs,
      expectedOutputs: null,
    });
    await expect(replayAnalyticsScenario(unknown)).rejects.toThrow(
      /Unsupported/,
    );
    const extra = await createScenarioReport({
      modelVersion: "fixed-lp-notes-v1",
      provenance,
      assumptions: ["Synthetic."],
      inputs: { ...inputs, hiddenAssumption: "ignored?" },
      expectedOutputs: null,
    });
    await expect(replayAnalyticsScenario(extra)).rejects.toThrow();
  });
});

describe("published history adapters", () => {
  const first: BrokerHistoryPoint = {
    blockNumber: "25853823",
    blockHash: provenance.observations[0]!.blockHash,
    timestamp: "2026-08-28T12:45:11.000Z",
    implementation: {
      address: "0x9Ce5056eEEd22e4569a39DAa670bacD277df3ef1",
      codeHash:
        "0x2005b63859f224931e9336ab2fb012c7edc4304deaa0c9d5bb59378ae63dfb3e",
    },
    usdBalance: "100000000",
    spotBalance: "25000000000",
    usdPrice: WAD.toString(),
    spotFmv: (4n * WAD).toString(),
    lpSupply: "100000000000000000000",
    lpDecimals: "18",
    paused: false,
    oracleStatus: "valid-at-observation",
    parameters: archivedBroker.parameters,
  };
  const second = {
    ...first,
    blockNumber: "25853824",
    timestamp: "2026-08-28T12:45:23.000Z",
  };

  it("rejects an unknown runtime or pre-supported epoch even with valid shape", () => {
    expect(brokerLpEndpoint(first).lpSupply).toBe(100n * WAD);
    expect(() =>
      brokerLpEndpoint({
        ...first,
        implementation: {
          ...first.implementation,
          codeHash: `0x${"0".repeat(64)}`,
        },
      }),
    ).toThrow(/code hash/);
    expect(() =>
      brokerLpEndpoint({ ...first, blockNumber: "22889950" }),
    ).toThrow(/unsupported/);
  });

  it("uses only real observed points and refuses changed LP precision", () => {
    const points = lpBenchmarkSeries([first, second], first, second, WAD);
    expect(points).toHaveLength(2);
    expect(points[0]?.lpValue).toEqual(fraction(2n));
    expect(points[1]?.holdingValue).toEqual(fraction(2n));
    expect(() =>
      lpBenchmarkSeries(
        [first, { ...second, lpDecimals: "9" }],
        first,
        { ...second, lpDecimals: "9" },
        WAD,
      ),
    ).toThrow(/precision/);
  });

  it("requires transfer coverage over both selected endpoints", () => {
    expect(() =>
      selectedBrokerLedger(
        {
          fromBlock: second.blockNumber,
          toBlock: second.blockNumber,
          coverage: "complete",
          events: [],
        },
        first,
        second,
      ),
    ).toThrow(/coverage/);
    expect(
      selectedBrokerLedger(
        {
          fromBlock: first.blockNumber,
          toBlock: second.blockNumber,
          coverage: "complete",
          events: [],
        },
        first,
        second,
      ).result.status,
    ).toBe("reconciled");
  });
});

describe("LP position display", () => {
  it("sizes the illustrative position against the smallest supply without floating-point loss", () => {
    expect(
      illustrativeLpNotes(
        ["100000000000000000000", "200000000000000000000"],
        "18",
      ),
    ).toBe("1");
    expect(illustrativeLpNotes(["48579276852161797184448588123"], "18")).toBe(
      "485792768.521617971844485881",
    );
    expect(illustrativeLpNotes(["7"], "18")).toBe("0.000000000000000001");
    expect(illustrativeLpNotes(["0"], "18")).toBeNull();
  });

  it("distinguishes real zero from positive and negative dust, including sub-WAD values", () => {
    expect(lpDollars(fraction(0n))).toBe("$0");
    expect(lpDollars(fraction(1n, 10n ** 19n))).toBe("$1.00e-19");
    expect(lpDollars(fraction(-239n, 10n ** 9n))).toBe("-$2.39e-7");
    expect(lpDollars(fraction(1n, 10_000n))).toBe("$0.0001");
    expect(lpDollars(fraction(-1n, 10_000n))).toBe("-$0.0001");
    expect(lpChartDollars(0.00000031)).toBe("$3.10e-7");
    expect(lpChartDollars(-0.00000031)).toBe("-$3.10e-7");
    expect(lpChartDollars(-0)).toBe("$0");
  });
});
