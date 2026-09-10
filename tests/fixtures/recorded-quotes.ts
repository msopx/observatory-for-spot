import { CONTRACTS } from "../../src/data/contracts";
import {
  DEVELOPMENT_FIXTURE_LABEL,
  brokerQuotesDatasetSchema,
  type BrokerQuote,
  type BrokerQuotesDataset,
} from "../../src/data/schemas";

/**
 * Synthetic recorded-quote dataset for unit tests. Labelled as a development
 * fixture at block 0 so it can never be mistaken for published evidence. The
 * numbers follow one linear rule so derived values are easy to check by hand:
 * 1 SPOT (1e9) sells for 1.2 USDC minus a 2% fee; 1 USDC buys 0.8 SPOT
 * minus a 2% fee. Prices: USDC $1.00, SPOT $1.25.
 */
const USD = CONTRACTS.usdc.address;
const SPOT = CONTRACTS.spot.address;

function quote(
  inputAsset: string,
  outputAsset: string,
  inputAmount: bigint,
  outputAmount: bigint | null,
  protocolFeeAmount: bigint | null,
): BrokerQuote {
  return outputAmount === null
    ? {
        inputAsset,
        outputAsset,
        inputAmount: inputAmount.toString(),
        available: false,
        outputAmount: null,
        protocolFeeAmount: null,
        unavailableReason: "zero-output",
      }
    : {
        inputAsset,
        outputAsset,
        inputAmount: inputAmount.toString(),
        available: true,
        outputAmount: outputAmount.toString(),
        protocolFeeAmount: (protocolFeeAmount ?? 0n).toString(),
        unavailableReason: null,
      };
}

export function recordedQuotesFixture(): BrokerQuotesDataset {
  const usdBalance = 200_000_000_000n; // 200,000 USDC
  const spotBalance = 400_000_000_000_000n; // 400,000 SPOT
  const spotToUsd = [1n, 10n, 100n, 1_000n, 1_000_000n].map((whole) => {
    const input = whole * 1_000_000_000n;
    const equal = whole * 1_250_000n; // $1.25 per SPOT in USDC base units
    const output = (equal * 98n) / 100n;
    return output > usdBalance
      ? quote(SPOT, USD, input, null, null)
      : quote(SPOT, USD, input, output, equal / 1_000n);
  });
  const usdToSpot = [1n, 10n, 100n, 1_000n, 1_000_000n].map((whole) => {
    const input = whole * 1_000_000n;
    const equal = whole * 800_000_000n; // 0.8 SPOT per USDC in SPOT base units
    const output = (equal * 98n) / 100n;
    return output > spotBalance
      ? quote(USD, SPOT, input, null, null)
      : quote(USD, SPOT, input, output, equal / 1_000n);
  });
  const lpSupply = 1_000_000_000_000_000_000_000n; // 1,000 LP at 18 decimals
  const lpRedemptions = [
    1_000_000_000_000_000_000n,
    10_000_000_000_000_000_000n,
    lpSupply,
  ].map((lpAmount) => {
    const usdOut = (usdBalance * lpAmount) / lpSupply;
    const spotOut = (spotBalance * lpAmount) / lpSupply;
    const postUsd = usdBalance - usdOut;
    const postSpot = spotBalance - spotOut;
    const equal = (spotOut * 1_250_000n) / 1_000_000_000n;
    const saleOutput = (equal * 98n) / 100n;
    return {
      lpAmount: lpAmount.toString(),
      available: true,
      usdOut: usdOut.toString(),
      spotOut: spotOut.toString(),
      unavailableReason: null,
      postWithdrawalReserves: {
        usdBalance: postUsd.toString(),
        spotBalance: postSpot.toString(),
      },
      sale:
        spotOut === 0n
          ? null
          : saleOutput > postUsd
            ? quote(SPOT, USD, spotOut, null, null)
            : quote(SPOT, USD, spotOut, saleOutput, equal / 1_000n),
    };
  });
  return brokerQuotesDatasetSchema.parse({
    metadata: {
      schemaVersion: 1,
      dataset: "broker-quotes",
      status: "fixture-not-final",
      generatedAt: "2026-08-28T00:00:00.000Z",
      chainId: 1,
      blockNumber: "0",
      blockHash: "fixture:block:recorded-quotes",
      blockTimestamp: null,
      provenance: {
        kind: "fixture",
        label: DEVELOPMENT_FIXTURE_LABEL,
        fixtureId: "recorded-quotes",
        generator: "tests/fixtures/recorded-quotes.ts",
        contracts: [],
        notes: ["Synthetic test data. Never published."],
      },
    },
    brokerAddress: CONTRACTS.billBroker.address,
    implementationAddress: "0x9Ce5056eEEd22e4569a39DAa670bacD277df3ef1",
    implementationCodeHash: "fixture:code:recorded-quotes",
    usdToken: { address: USD, name: "USD Coin", symbol: "USDC", decimals: "6" },
    spotToken: { address: SPOT, name: "SPOT", symbol: "SPOT", decimals: "9" },
    reserveState: {
      usdBalance: usdBalance.toString(),
      spotBalance: spotBalance.toString(),
      usdPrice: "1000000000000000000",
      spotPrice: "1250000000000000000",
    },
    lpSupply: lpSupply.toString(),
    lpDecimals: "18",
    burnFeePercent: "0",
    grid: {
      definition: {
        quarterDecadeMantissasThousandths: ["1000"],
        maximumPoints: 5,
        stopAfterUnavailable: 2,
        lpSupplyBasisPoints: ["10", "100", "10000"],
      },
      spotToUsd,
      usdToSpot,
    },
    lpRedemptions,
  });
}
