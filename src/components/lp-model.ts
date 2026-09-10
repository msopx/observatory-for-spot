import {
  benchmarkLpNotes,
  reconcileLpLedger,
  type LpEndpoint,
} from "../analytics/lp";
import {
  MAINNET_DEPLOYMENTS,
  assertSupportedImplementation,
} from "../protocol/deployments";
import type {
  BrokerHistoryPoint,
  BrokerLedger,
} from "../data/observatory-schemas";
import type { ScenarioProvenance } from "../analytics/scenarios";
import type { Address, Hex } from "viem";

/** Fail closed on a changed Broker implementation before calculating returns. */
export function brokerLpEndpoint(point: BrokerHistoryPoint): LpEndpoint {
  assertSupportedImplementation(
    MAINNET_DEPLOYMENTS.billBroker,
    BigInt(point.blockNumber),
    point.implementation.address as Address,
    point.implementation.codeHash as Hex,
  );
  if (point.oracleStatus !== "valid-at-observation")
    throw new Error("The valuation oracle was not valid at this observation");
  return {
    blockNumber: BigInt(point.blockNumber),
    timestamp: BigInt(Date.parse(point.timestamp) / 1_000),
    usdc: BigInt(point.usdBalance),
    spot: BigInt(point.spotBalance),
    lpSupply: BigInt(point.lpSupply),
    usdcPrice: BigInt(point.usdPrice),
    spotFmv: BigInt(point.spotFmv),
  };
}

/** Every chart point is an observation, never a synthesized daily return. */
export function lpBenchmarkSeries(
  points: readonly BrokerHistoryPoint[],
  start: BrokerHistoryPoint,
  end: BrokerHistoryPoint,
  lpAmount: bigint,
) {
  if (start.lpDecimals !== end.lpDecimals)
    throw new Error(
      "LP token precision changed between the selected observations",
    );
  const first = brokerLpEndpoint(start);
  const benchmark = benchmarkLpNotes({
    start: first,
    end: brokerLpEndpoint(end),
    lpAmount,
  });
  const selected = points.filter(
    (point) =>
      BigInt(point.blockNumber) >= first.blockNumber &&
      BigInt(point.blockNumber) <= BigInt(end.blockNumber),
  );
  return selected.map((point) => {
    if (point.lpDecimals !== start.lpDecimals)
      throw new Error("LP token precision changed during this period");
    const value =
      point.blockNumber === start.blockNumber
        ? null
        : benchmarkLpNotes({
            start: first,
            end: brokerLpEndpoint(point),
            lpAmount,
          });
    return {
      blockNumber: point.blockNumber,
      timestamp: point.timestamp,
      lpValue: value?.endValue ?? benchmark.startValue,
      holdingValue: value?.holdingEndValue ?? benchmark.startValue,
    };
  });
}

export function lpScenarioProvenance(
  start: BrokerHistoryPoint,
  end: BrokerHistoryPoint,
  sourceHash: string,
): ScenarioProvenance {
  return {
    chainId: "1",
    observations: [start, end].map((point) => ({
      blockNumber: point.blockNumber,
      blockHash: point.blockHash,
      timestamp: point.timestamp,
      contracts: [
        {
          address: MAINNET_DEPLOYMENTS.billBroker.address,
          implementationAddress: point.implementation.address,
          runtimeCodeHash: point.implementation.codeHash,
          interfaceVersion: "bill-broker-v5-factor",
        },
      ],
    })),
    datasets: [{ name: "broker-history", sha256: `sha256:${sourceHash}` }],
  };
}

export function selectedBrokerLedger(
  ledger: BrokerLedger,
  start: BrokerHistoryPoint,
  end: BrokerHistoryPoint,
) {
  if (
    BigInt(ledger.fromBlock) > BigInt(start.blockNumber) ||
    BigInt(ledger.toBlock) < BigInt(end.blockNumber)
  )
    throw new Error(
      "Published transfer coverage does not cover both selected endpoints",
    );
  const inputs = {
    start: brokerLpEndpoint(start),
    end: brokerLpEndpoint(end),
    coverage: ledger.coverage,
    events: ledger.events
      .filter(
        (event) =>
          BigInt(event.blockNumber) > BigInt(start.blockNumber) &&
          BigInt(event.blockNumber) <= BigInt(end.blockNumber),
      )
      .map((event) => ({
        blockNumber: BigInt(event.blockNumber),
        logIndex: BigInt(event.logIndex),
        transactionHash: event.transactionHash,
        kind: event.kind,
        usdcDelta: BigInt(event.usdcDelta),
        spotDelta: BigInt(event.spotDelta),
        lpSupplyDelta: BigInt(event.lpSupplyDelta),
        fee:
          event.fee === null
            ? null
            : {
                asset: event.fee.asset,
                amount: BigInt(event.fee.amount),
                protocolAmount: BigInt(event.fee.protocolAmount),
                evidence: event.fee.evidence,
              },
      })),
  };
  return { inputs, result: reconcileLpLedger(inputs) };
}
