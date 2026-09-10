import { keccak256, parseAbi, parseAbiItem } from "viem";

import {
  AMPL_POLICY_REBASE_EVENT,
  AMPL_POLICY_REBASE_V2_EVENT,
  AMPL_TOKEN_REBASE_EVENT,
  CONTRACTS,
  EIP1967_IMPLEMENTATION_SLOT,
  ERC20_METADATA_ABI,
  ROLLOVER_VAULT_ABI,
} from "./contracts";
import {
  publishObservatoryRefresh,
  readObservatoryManifest,
  readPublishedFeed,
  type FeedRefreshResult,
} from "./observatory-files";
import { readSpotMarketHistory } from "./observatory-market";
import { readBrokerLedger } from "./observatory-ledger";
import {
  OBSERVATORY_FEEDS,
  observatoryDatasetSchema,
  type BlockObservation,
  type BrokerHistoryEvent,
  type BrokerHistoryPoint,
  type CollateralAsset,
  type CollateralPoint,
  type ExitInputsPoint,
  type ImplementationEvidence,
  type ObservatoryDataset,
  type ObservatoryDatasetFor,
  type ObservatoryFeed,
  type ObservatoryManifest,
  type SpotHistoryPoint,
  type StamplHistoryPoint,
} from "./observatory-schemas";
import {
  UnsupportedProtocolIntegrationError,
  fetchLogsAdaptive,
  normalizeAmplPolicyLog,
  normalizeAmplPolicyV2Log,
  normalizeAmplTokenLog,
  pairAmplRebaseLogs,
  readAmplRebasesDataset,
  readBrokerStateDataset,
  readSpotHealthDataset,
  resolveReleaseBlock,
  verifyReleaseBlockCanonical,
  type AmplTargetRateResolver,
  type ObservatoryLogClient,
  type ObservatoryPublicClient,
  type ProtocolImplementationVerifier,
  type ReleaseBlockRequest,
  type ResolvedReleaseBlock,
} from "./refresh";
import {
  amplRebasesDatasetSchema,
  evmAddressSchema,
  evmHashSchema,
  type AmplRebaseRow,
  type AmplRebasesDataset,
  type BrokerStateDataset,
  type SpotHealthDataset,
  type TokenDescriptor,
} from "./schemas";
import { compareAmplRebaseRows } from "./writers";

const STATE_ABI = parseAbi([
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function feePolicy() view returns (address)",
  "function computeRedemptionAmts(uint256 burnAmt) view returns (uint256 usdAmtOut,uint256 perpAmtOut)",
]);
const SPOT_REDEMPTION_ABI = parseAbi([
  "function computeRedemptionAmts(uint256 perpAmt) returns ((address token,uint256 amount)[])",
]);
const FUNDING_ABI = parseAbi([
  "function computeRebalanceAmount((uint256 perpTVL,uint256 vaultTVL) s) view returns (int256)",
  "function rebalanceFreqSec() view returns (uint256)",
  "function lastRebalanceTimestampSec() view returns (uint256)",
]);
const BOND_DETAILS_ABI = parseAbi([
  "function bond() view returns (address)",
  "function collateralToken() view returns (address)",
  "function collateralBalance() view returns (uint256)",
  "function maturityDate() view returns (uint256)",
  "function isMature() view returns (bool)",
  "function trancheCount() view returns (uint256)",
  "function tranches(uint256 index) view returns (address token,uint256 ratio)",
]);
const BROKER_EVENT_ABIS = [
  parseAbiItem(
    "event SwapPerpsForUSD(uint256 perpAmtIn,(uint256 usdBalance,uint256 perpBalance,uint256 usdPrice,uint256 perpPrice) preOpState)",
  ),
  parseAbiItem(
    "event SwapUSDForPerps(uint256 usdAmtIn,(uint256 usdBalance,uint256 perpBalance,uint256 usdPrice,uint256 perpPrice) preOpState)",
  ),
  parseAbiItem(
    "event DepositUSD(uint256 usdAmtIn,(uint256 usdBalance,uint256 perpBalance,uint256 usdPrice,uint256 perpPrice) preOpState)",
  ),
  parseAbiItem(
    "event DepositPerp(uint256 perpAmtIn,(uint256 usdBalance,uint256 perpBalance,uint256 usdPrice,uint256 perpPrice) preOpState)",
  ),
  parseAbiItem(
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ),
] as const;

type Address = `0x${string}`;
function uint(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  throw new Error("Contract returned an invalid unsigned integer");
}
function signed(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  throw new Error("Contract returned an invalid signed integer");
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unexpected contract tuple");
  return value as Record<string, unknown>;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new Error("Contract returned an invalid boolean");
  return value;
}
function address(value: unknown): Address {
  return evmAddressSchema.parse(value) as Address;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error("Contract returned an invalid array");
  return value;
}
function observation(block: ResolvedReleaseBlock): BlockObservation {
  return {
    blockNumber: block.number.toString(),
    blockHash: block.hash,
    timestamp: block.timestampIso,
  };
}
function envelope<F extends ObservatoryFeed>(feed: F, generatedAt: string) {
  return {
    schemaVersion: 1 as const,
    feed,
    generatedAt,
    chainId: 1 as const,
    source: "ethereum-rpc" as const,
    notes: [
      "Reads are pinned to recorded Ethereum blocks. Core proxy identities are compared with the registry; individual collateral identity status is recorded per asset.",
    ],
  };
}
async function read(
  client: ObservatoryPublicClient,
  blockNumber: bigint,
  contractAddress: Address,
  abi: unknown,
  functionName: string,
  args?: readonly unknown[],
): Promise<unknown> {
  return client.readContract({
    address: contractAddress,
    abi,
    functionName,
    blockNumber,
    ...(args === undefined ? {} : { args }),
  });
}

export async function readVerifiedImplementation(
  client: ObservatoryPublicClient,
  blockNumber: bigint,
  contract: "spot" | "rolloverVault" | "feePolicy" | "billBroker",
  verifier: ProtocolImplementationVerifier,
): Promise<ImplementationEvidence> {
  const contractAddress =
    contract === "feePolicy"
      ? CONTRACTS.spotFeePolicy.address
      : CONTRACTS[contract].address;
  const storage = await client.getStorageAt({
    address: contractAddress,
    blockNumber,
    slot: EIP1967_IMPLEMENTATION_SLOT,
  });
  if (storage === undefined || !/^0x[0-9a-fA-F]{64}$/.test(storage))
    throw new UnsupportedProtocolIntegrationError(
      "Implementation slot is unavailable",
    );
  const implementationAddress = address(`0x${storage.slice(-40)}`);
  const code = await client.getCode({
    address: implementationAddress,
    blockNumber,
  });
  if (code === undefined || code === "0x")
    throw new UnsupportedProtocolIntegrationError(
      "Implementation runtime is unavailable",
    );
  const runtimeCodeHash = keccak256(code);
  await verifier.verifyImplementation({
    contract,
    blockNumber,
    implementationAddress,
    runtimeCodeHash,
  });
  return { address: implementationAddress, codeHash: runtimeCodeHash };
}

export interface ObservatoryRefreshOptions {
  client: ObservatoryPublicClient;
  logClient?: ObservatoryLogClient;
  releaseBlock: ReleaseBlockRequest;
  sampleBlocks?: readonly bigint[];
  outputDirectory: string;
  implementationVerifier: ProtocolImplementationVerifier;
  targetRateResolver: AmplTargetRateResolver;
  previousAmpl?: AmplRebasesDataset;
  now?: () => Date;
  includeMarket?: boolean;
  marketReader?: typeof readSpotMarketHistory;
  historyDays?: number;
  feeds?: readonly ObservatoryFeed[];
  onProgress?: (event: {
    feed: ObservatoryFeed;
    status: "started" | "ok" | "error";
    rowCount?: number;
  }) => void;
  /** Optional allowlist backed by independently checked deployed bond runtime. */
  verifyBondRuntime?: (input: {
    address: Address;
    runtime: `0x${string}`;
    blockNumber: bigint;
    trancheTokens: readonly Address[];
  }) => Promise<boolean>;
  initialLogRange?: bigint;
  maximumLogRange?: bigint;
  maximumLogsPerResponse?: number;
}

/**
 * Fields that identify one recorded rebase. Log positions are not part of an
 * event's identity and are excluded from the comparison; the baseline's values
 * are kept for shared epochs.
 */
const AMPL_ROW_IDENTITY: ReadonlyArray<keyof AmplRebaseRow> = [
  "blockNumber",
  "blockHash",
  "transactionHash",
  "timestamp",
  "exchangeRate",
  "cpiAdjustedTargetRate",
  "requestedSupplyAdjustment",
  "totalSupply",
];

/**
 * Seeds the next incremental read from the union of the packaged release
 * baseline and the published feed, keyed by epoch. The baseline is
 * authoritative for its range, so a published feed cannot carry gaps forward;
 * the feed contributes the epochs it indexed after the baseline. Any
 * disagreement on the identity of a shared epoch is a data fault and stops the
 * refresh.
 */
export function mergeAmplHistoryBaseline(
  baseline: AmplRebasesDataset,
  feed: Pick<ObservatoryDatasetFor<"ampl-history">, "rows" | "generatedAt"> | null,
): AmplRebasesDataset {
  if (feed === null || feed.rows.length === 0) return baseline;
  const byEpoch = new Map<string, AmplRebaseRow>();
  for (const row of feed.rows) byEpoch.set(BigInt(row.epoch).toString(), row);
  for (const row of baseline.rows) {
    const epoch = BigInt(row.epoch).toString();
    const published = byEpoch.get(epoch);
    if (published !== undefined) {
      for (const field of AMPL_ROW_IDENTITY) {
        const left = String(row[field] ?? "").toLowerCase();
        const right = String(published[field] ?? "").toLowerCase();
        if (left !== right)
          throw new Error(
            `Published AMPL history disagrees with the release baseline for epoch ${epoch} (${field})`,
          );
      }
    }
    byEpoch.set(epoch, row);
  }
  const rows = [...byEpoch.values()].sort(compareAmplRebaseRows);
  const last = rows.at(-1)!;
  const baselineIsNewest = BigInt(last.blockNumber) <= BigInt(baseline.metadata.blockNumber);
  return amplRebasesDatasetSchema.parse({
    ...baseline,
    rows,
    metadata: {
      ...baseline.metadata,
      generatedAt: baselineIsNewest
        ? baseline.metadata.generatedAt
        : feed.generatedAt,
      blockNumber: baselineIsNewest
        ? baseline.metadata.blockNumber
        : last.blockNumber,
      blockHash: baselineIsNewest ? baseline.metadata.blockHash : last.blockHash,
      blockTimestamp: baselineIsNewest
        ? baseline.metadata.blockTimestamp
        : last.timestamp,
    },
  });
}

/** Increment from the last paired rebase, retaining its event to anchor supply changes. */
export async function readAmplHistoryIncremental(
  options: Pick<
    ObservatoryRefreshOptions,
    | "client"
    | "logClient"
    | "targetRateResolver"
    | "initialLogRange"
    | "maximumLogRange"
    | "maximumLogsPerResponse"
  >,
  releaseBlock: ResolvedReleaseBlock,
  generatedAt: string,
  previous?: AmplRebasesDataset,
): Promise<AmplRebasesDataset> {
  if (
    previous === undefined ||
    previous.rows.length === 0 ||
    previous.metadata.provenance.kind !== "ethereum-rpc"
  ) {
    return readAmplRebasesDataset(
      options.client,
      releaseBlock,
      generatedAt,
      options.targetRateResolver,
      {
        ...(options.initialLogRange === undefined
          ? {}
          : { initial: options.initialLogRange }),
        ...(options.maximumLogRange === undefined
          ? {}
          : { maximum: options.maximumLogRange }),
        ...(options.maximumLogsPerResponse === undefined
          ? {}
          : { responseLimit: options.maximumLogsPerResponse }),
      },
      options.logClient ?? options.client,
    );
  }
  const last = [...previous.rows]
    .sort((a, b) => (BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1))
    .at(-1)!;
  if (BigInt(previous.metadata.blockNumber) > releaseBlock.number)
    throw new Error("AMPL refresh would move backwards");
  const anchor = await options.client.getBlock({
    blockNumber: BigInt(last.blockNumber),
  });
  if (anchor.hash?.toLowerCase() !== last.blockHash.toLowerCase())
    throw new Error("AMPL history anchor is no longer canonical");
  const logs = await Promise.all(
    [
      [CONTRACTS.amplPolicy.address, AMPL_POLICY_REBASE_EVENT],
      [CONTRACTS.amplPolicy.address, AMPL_POLICY_REBASE_V2_EVENT],
      [CONTRACTS.amplToken.address, AMPL_TOKEN_REBASE_EVENT],
    ].map(([contractAddress, event]) =>
      fetchLogsAdaptive({
        client: options.logClient ?? options.client,
        address: contractAddress as Address,
        event,
        fromBlock: BigInt(last.blockNumber),
        toBlock: releaseBlock.number,
        ...(options.initialLogRange === undefined
          ? {}
          : { initialRange: options.initialLogRange }),
        ...(options.maximumLogRange === undefined
          ? {}
          : { maximumRange: options.maximumLogRange }),
        ...(options.maximumLogsPerResponse === undefined
          ? {}
          : { maximumLogsPerResponse: options.maximumLogsPerResponse }),
      }),
    ),
  );
  const v2 = await Promise.all(
    logs[1]!.map(async (rawLog) => {
      const log = record(rawLog);
      const block = await options.client.getBlock({
        blockNumber: uint(log.blockNumber),
      });
      if (block.hash?.toLowerCase() !== String(log.blockHash).toLowerCase())
        throw new Error("AMPL event block changed");
      return normalizeAmplPolicyV2Log(rawLog, block.timestamp);
    }),
  );
  const appended = await pairAmplRebaseLogs(
    [...logs[0]!.map(normalizeAmplPolicyLog), ...v2],
    logs[2]!.map(normalizeAmplTokenLog),
    options.targetRateResolver,
  );
  const first = appended[0];
  if (
    first === undefined ||
    first.epoch !== last.epoch ||
    first.totalSupply !== last.totalSupply ||
    first.transactionHash.toLowerCase() !== last.transactionHash.toLowerCase()
  ) {
    throw new Error("Incremental AMPL history does not match its anchor");
  }
  const rows = [...previous.rows, ...appended.slice(1)];
  return amplRebasesDatasetSchema.parse({
    ...previous,
    metadata: {
      ...previous.metadata,
      generatedAt,
      blockNumber: releaseBlock.number.toString(),
      blockHash: releaseBlock.hash,
      blockTimestamp: releaseBlock.timestampIso,
    },
    rows,
  });
}

async function brokerPoint(
  client: ObservatoryPublicClient,
  block: ResolvedReleaseBlock,
  state: BrokerStateDataset,
): Promise<BrokerHistoryPoint> {
  const [lpSupply, lpDecimals, paused] = await Promise.all([
    read(
      client,
      block.number,
      CONTRACTS.billBroker.address,
      STATE_ABI,
      "totalSupply",
    ),
    read(
      client,
      block.number,
      CONTRACTS.billBroker.address,
      STATE_ABI,
      "decimals",
    ),
    read(
      client,
      block.number,
      CONTRACTS.billBroker.address,
      STATE_ABI,
      "paused",
    ),
  ]);
  return {
    ...observation(block),
    implementation: {
      address: state.implementationAddress,
      codeHash: state.implementationCodeHash,
    },
    usdBalance: state.reserveState.usdBalance,
    spotBalance: state.reserveState.spotBalance,
    usdPrice: state.reserveState.usdPrice,
    spotFmv: state.reserveState.spotPrice,
    lpSupply: uint(lpSupply).toString(),
    lpDecimals: uint(lpDecimals).toString(),
    paused: boolean(paused),
    oracleStatus: "valid-at-observation",
    parameters: state.parameters,
  };
}

async function stamplPoint(
  options: ObservatoryRefreshOptions,
  block: ResolvedReleaseBlock,
  state: SpotHealthDataset,
): Promise<StamplHistoryPoint> {
  const [
    implementation,
    feePolicyImplementation,
    decimalsValue,
    pausedValue,
    feePolicyAddress,
  ] = await Promise.all([
    readVerifiedImplementation(
      options.client,
      block.number,
      "rolloverVault",
      options.implementationVerifier,
    ),
    readVerifiedImplementation(
      options.client,
      block.number,
      "feePolicy",
      options.implementationVerifier,
    ),
    read(
      options.client,
      block.number,
      CONTRACTS.rolloverVault.address,
      STATE_ABI,
      "decimals",
    ),
    read(
      options.client,
      block.number,
      CONTRACTS.rolloverVault.address,
      STATE_ABI,
      "paused",
    ),
    read(
      options.client,
      block.number,
      CONTRACTS.rolloverVault.address,
      STATE_ABI,
      "feePolicy",
    ),
  ]);
  if (
    address(feePolicyAddress).toLowerCase() !==
    CONTRACTS.spotFeePolicy.address.toLowerCase()
  )
    throw new UnsupportedProtocolIntegrationError(
      "Vault references an unsupported fee policy",
    );
  const decimals = uint(decimalsValue);
  if (decimals > 36n) throw new Error("Unsupported stAMPL decimals");
  const [fundingValue, period, lastRebalance] = await Promise.all([
    read(
      options.client,
      block.number,
      CONTRACTS.spotFeePolicy.address,
      FUNDING_ABI,
      "computeRebalanceAmount",
      [
        {
          perpTVL: BigInt(state.spot.collateralTvl),
          vaultTVL: BigInt(state.rolloverVault.tvl),
        },
      ],
    ),
    read(
      options.client,
      block.number,
      CONTRACTS.spotFeePolicy.address,
      FUNDING_ABI,
      "rebalanceFreqSec",
    ),
    read(
      options.client,
      block.number,
      CONTRACTS.rolloverVault.address,
      FUNDING_ABI,
      "lastRebalanceTimestampSec",
    ),
  ]);
  const supply = BigInt(state.rolloverVault.totalSupply);
  if (supply === 0n) throw new Error("stAMPL supply is zero");
  return {
    ...observation(block),
    implementation,
    feePolicyImplementation,
    collateralAmpl: state.rolloverVault.tvl,
    totalSupply: supply.toString(),
    decimals: decimals.toString(),
    amplPerStamplWad: (
      (BigInt(state.rolloverVault.tvl) * 10n ** decimals * 10n ** 18n) /
      (supply * 10n ** 9n)
    ).toString(),
    deviationRatio: state.rolloverVault.deviationRatio,
    deviationRatioDecimals: state.rolloverVault.deviationRatioDecimals,
    indicatedFundingAmpl: signed(fundingValue).toString(),
    fundingPeriodSeconds: uint(period).toString(),
    lastRebalanceTimestamp: uint(lastRebalance).toString(),
    rebalancePaused: uint(lastRebalance) === 2n ** 64n - 1n,
    paused: boolean(pausedValue),
  };
}

async function tokenDescriptor(
  client: ObservatoryPublicClient,
  block: bigint,
  token: Address,
): Promise<TokenDescriptor> {
  const [decimals, name, symbol] = await Promise.all([
    read(client, block, token, ERC20_METADATA_ABI, "decimals"),
    read(client, block, token, ERC20_METADATA_ABI, "name").catch(() => null),
    read(client, block, token, ERC20_METADATA_ABI, "symbol").catch(() => null),
  ]);
  return {
    address: token,
    decimals: uint(decimals).toString(),
    name: typeof name === "string" ? name : null,
    symbol: typeof symbol === "string" ? symbol : null,
  };
}

async function bondEvidence(
  options: ObservatoryRefreshOptions,
  block: ResolvedReleaseBlock,
  token: Address,
  holding: bigint,
): Promise<CollateralAsset["bond"]> {
  const client = options.client;
  const bond = address(
    await read(client, block.number, token, BOND_DETAILS_ABI, "bond"),
  );
  const [
    code,
    collateral,
    isMature,
    maturity,
    count,
    seniorTuple,
    juniorTuple,
    collateralToken,
  ] = await Promise.all([
    client.getCode({ address: bond, blockNumber: block.number }),
    read(client, block.number, bond, BOND_DETAILS_ABI, "collateralBalance"),
    read(client, block.number, bond, BOND_DETAILS_ABI, "isMature"),
    read(client, block.number, bond, BOND_DETAILS_ABI, "maturityDate"),
    read(client, block.number, bond, BOND_DETAILS_ABI, "trancheCount"),
    read(client, block.number, bond, BOND_DETAILS_ABI, "tranches", [0n]),
    read(client, block.number, bond, BOND_DETAILS_ABI, "tranches", [1n]),
    read(client, block.number, bond, BOND_DETAILS_ABI, "collateralToken"),
  ]);
  if (
    code === undefined ||
    code === "0x" ||
    uint(count) !== 2n ||
    address(collateralToken).toLowerCase() !==
      CONTRACTS.amplToken.address.toLowerCase()
  ) {
    throw new UnsupportedProtocolIntegrationError(
      "Unsupported collateral bond structure",
    );
  }
  const seniorToken = address(array(seniorTuple)[0]);
  const juniorToken = address(array(juniorTuple)[0]);
  if (
    token.toLowerCase() !== seniorToken.toLowerCase() &&
    token.toLowerCase() !== juniorToken.toLowerCase()
  )
    throw new Error("Holding is not one of its bond's tranches");
  const [supply, seniorCollateral, parent] = await Promise.all([
    read(client, block.number, seniorToken, ERC20_METADATA_ABI, "totalSupply"),
    read(
      client,
      block.number,
      CONTRACTS.amplToken.address,
      ERC20_METADATA_ABI,
      "balanceOf",
      [seniorToken],
    ),
    read(client, block.number, seniorToken, BOND_DETAILS_ABI, "bond"),
  ]);
  if (address(parent).toLowerCase() !== bond.toLowerCase())
    throw new Error("Senior tranche does not point back to its bond");
  const verified =
    (await options.verifyBondRuntime?.({
      address: bond,
      runtime: code,
      blockNumber: block.number,
      trancheTokens: [seniorToken, token],
    })) ?? false;
  return {
    address: bond,
    codeHash: keccak256(code),
    maturityTimestamp: uint(maturity).toString(),
    isMature: boolean(isMature),
    collateralUnderlying: uint(collateral).toString(),
    seniorClaim: uint(supply).toString(),
    seniorSupply: uint(supply).toString(),
    seniorToken,
    seniorCollateral: uint(seniorCollateral).toString(),
    heldSenior:
      token.toLowerCase() === seniorToken.toLowerCase()
        ? holding.toString()
        : "0",
    identity: verified ? "verified" : "unverified",
  };
}

async function collateralPoint(
  options: ObservatoryRefreshOptions,
  block: ResolvedReleaseBlock,
  state: SpotHealthDataset,
): Promise<CollateralPoint> {
  const [vaultImplementation, countValue] = await Promise.all([
    readVerifiedImplementation(
      options.client,
      block.number,
      "rolloverVault",
      options.implementationVerifier,
    ),
    read(
      options.client,
      block.number,
      CONTRACTS.rolloverVault.address,
      ROLLOVER_VAULT_ABI,
      "assetCount",
    ),
  ]);
  const count = uint(countValue);
  if (count > 256n)
    throw new Error("Vault inventory exceeds supported enumeration limit");
  const underlying = state.reserves.find(
    (reserve) => reserve.isUnderlying,
  )?.token;
  if (
    underlying === undefined ||
    underlying.address.toLowerCase() !==
      CONTRACTS.amplToken.address.toLowerCase()
  )
    throw new Error("SPOT underlying is unsupported");
  const spot = await Promise.all(
    state.reserves.map(
      async (reserve): Promise<CollateralAsset> => ({
        token: reserve.token,
        balance: reserve.balance,
        underlyingValue: reserve.underlyingValue,
        isUnderlying: reserve.isUnderlying,
        bond: reserve.isUnderlying
          ? null
          : await bondEvidence(
              options,
              block,
              address(reserve.token.address),
              BigInt(reserve.balance),
            ),
      }),
    ),
  );
  const vault = await Promise.all(
    Array.from(
      { length: Number(count) },
      async (_, index): Promise<CollateralAsset> => {
        const token = address(
          await read(
            options.client,
            block.number,
            CONTRACTS.rolloverVault.address,
            ROLLOVER_VAULT_ABI,
            "assetAt",
            [BigInt(index)],
          ),
        );
        const [descriptor, balanceValue, value] = await Promise.all([
          tokenDescriptor(options.client, block.number, token),
          read(
            options.client,
            block.number,
            CONTRACTS.rolloverVault.address,
            ROLLOVER_VAULT_ABI,
            "vaultAssetBalance",
            [token],
          ),
          read(
            options.client,
            block.number,
            CONTRACTS.rolloverVault.address,
            ROLLOVER_VAULT_ABI,
            "getVaultAssetValue",
            [token],
          ),
        ]);
        const balance = uint(balanceValue);
        const isUnderlying =
          token.toLowerCase() === underlying.address.toLowerCase();
        return {
          token: descriptor,
          balance: balance.toString(),
          underlyingValue: uint(value).toString(),
          isUnderlying,
          bond: isUnderlying
            ? null
            : await bondEvidence(options, block, token, balance),
        };
      },
    ),
  );
  return {
    ...observation(block),
    spotImplementation: {
      address: state.spot.implementationAddress,
      codeHash: state.spot.implementationCodeHash,
    },
    vaultImplementation,
    underlying,
    spot,
    vault,
  };
}

async function exitPoint(
  options: ObservatoryRefreshOptions,
  block: ResolvedReleaseBlock,
  spot: SpotHealthDataset,
  broker: BrokerHistoryPoint,
): Promise<ExitInputsPoint> {
  const spotPaused = boolean(
    await read(
      options.client,
      block.number,
      CONTRACTS.spot.address,
      STATE_ABI,
      "paused",
    ),
  );
  const spotAmounts = [1n, 10n, 100n, 1_000n, 10_000n]
    .map((amount) => amount * 10n ** 9n)
    .filter((amount) => amount <= BigInt(spot.spot.totalSupply));
  const spotRedemptions = await Promise.all(
    spotAmounts.map(async (inputAmount) => {
      if (spotPaused)
        return {
          inputAmount: inputAmount.toString(),
          available: false,
          tokensOut: [],
          reason: "paused" as const,
        };
      try {
        const values = array(
          await read(
            options.client,
            block.number,
            CONTRACTS.spot.address,
            SPOT_REDEMPTION_ABI,
            "computeRedemptionAmts",
            [inputAmount],
          ),
        );
        const tokensOut = values.map((value) => {
          const tokenAmount = record(value);
          return {
            token: address(tokenAmount.token),
            amount: uint(tokenAmount.amount).toString(),
          };
        });
        return {
          inputAmount: inputAmount.toString(),
          available: true,
          tokensOut,
          reason: null,
        };
      } catch {
        return {
          inputAmount: inputAmount.toString(),
          available: false,
          tokensOut: [],
          reason: "contract-reverted" as const,
        };
      }
    }),
  );
  const lpUnit = 10n ** BigInt(broker.lpDecimals);
  const lpAmounts = [lpUnit, BigInt(broker.lpSupply) / 100n].filter(
    (amount, index, values) =>
      amount > 0n &&
      amount <= BigInt(broker.lpSupply) &&
      values.indexOf(amount) === index,
  );
  const brokerRedemptions = await Promise.all(
    lpAmounts.map(async (inputAmount) => {
      const values = array(
        await read(
          options.client,
          block.number,
          CONTRACTS.billBroker.address,
          STATE_ABI,
          "computeRedemptionAmts",
          [inputAmount],
        ),
      );
      return {
        inputAmount: inputAmount.toString(),
        usdAmount: uint(values[0]).toString(),
        spotAmount: uint(values[1]).toString(),
      };
    }),
  );
  return {
    ...observation(block),
    spotImplementation: {
      address: spot.spot.implementationAddress,
      codeHash: spot.spot.implementationCodeHash,
    },
    brokerImplementation: broker.implementation,
    spotPaused,
    brokerPaused: broker.paused,
    spotTotalSupply: spot.spot.totalSupply,
    brokerLpSupply: broker.lpSupply,
    brokerLpDecimals: broker.lpDecimals,
    brokerBurnFeePercent: broker.parameters.fees.burnFeePercent,
    brokerFeeUnit: broker.parameters.one,
    spotReserves: spot.reserves,
    spotRedemptions,
    brokerRedemptions,
  };
}

export async function readBrokerHistoryEvents(
  options: ObservatoryRefreshOptions,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<BrokerHistoryEvent[]> {
  const blocks = new Map<string, Promise<ResolvedReleaseBlock>>();
  const events = await Promise.all(
    BROKER_EVENT_ABIS.map(async (event) => {
      const logs = await fetchLogsAdaptive({
        client: options.logClient ?? options.client,
        address: CONTRACTS.billBroker.address,
        event,
        fromBlock,
        toBlock,
        ...(options.initialLogRange === undefined
          ? {}
          : { initialRange: options.initialLogRange }),
        ...(options.maximumLogRange === undefined
          ? {}
          : { maximumRange: options.maximumLogRange }),
        ...(options.maximumLogsPerResponse === undefined
          ? {}
          : { maximumLogsPerResponse: options.maximumLogsPerResponse }),
      });
      const rows = await Promise.all(
        logs.map(async (rawLog): Promise<BrokerHistoryEvent | null> => {
          const log = record(rawLog);
          const args = record(log.args);
          let eventName: BrokerHistoryEvent["event"];
          let amount: bigint;
          let preState: BrokerHistoryEvent["preState"] = null;
          if (event.name === "Transfer") {
            const from = address(args.from);
            const to = address(args.to);
            if (/^0x0{40}$/i.test(from)) eventName = "LpMint";
            else if (/^0x0{40}$/i.test(to)) eventName = "LpBurn";
            else return null;
            amount = uint(args.value);
          } else {
            eventName = event.name;
            amount = uint(args.perpAmtIn ?? args.usdAmtIn);
            const state = record(args.preOpState);
            preState = {
              usdBalance: uint(state.usdBalance).toString(),
              spotBalance: uint(state.perpBalance).toString(),
              usdPrice: uint(state.usdPrice).toString(),
              spotPrice: uint(state.perpPrice).toString(),
            };
          }
          const number = uint(log.blockNumber);
          const key = number.toString();
          let block = blocks.get(key);
          if (block === undefined) {
            block = resolveReleaseBlock(options.client, {
              number,
              expectedHash: evmHashSchema.parse(log.blockHash) as `0x${string}`,
            });
            blocks.set(key, block);
          }
          return {
            ...observation(await block),
            transactionHash: evmHashSchema.parse(log.transactionHash),
            logIndex: uint(log.logIndex).toString(),
            event: eventName,
            amount: amount.toString(),
            preState,
            feeAttribution: "transaction-parameters-unverified",
          };
        }),
      );
      return rows.filter((row): row is BrokerHistoryEvent => row !== null);
    }),
  );
  return events
    .flat()
    .sort((a, b) =>
      BigInt(a.blockNumber) < BigInt(b.blockNumber)
        ? -1
        : BigInt(a.blockNumber) > BigInt(b.blockNumber)
          ? 1
          : Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
    );
}

function mergeRows<F extends ObservatoryFeed>(
  feed: F,
  previous: ObservatoryDataset | null,
  next: ObservatoryDatasetFor<F>,
): ObservatoryDatasetFor<F> {
  if (previous === null || previous.feed !== feed) return next;
  const oldRows = previous.rows as Array<{
    timestamp: string;
    blockNumber?: string;
    blockHash?: string;
  }>;
  const newRows = next.rows as Array<{
    timestamp: string;
    blockNumber?: string;
    blockHash?: string;
  }>;
  const keyed = new Map(
    oldRows.map((row) => [row.blockNumber ?? row.timestamp, row]),
  );
  for (const row of newRows) {
    const key = row.blockNumber ?? row.timestamp;
    const existing = keyed.get(key);
    if (
      existing?.blockHash !== undefined &&
      row.blockHash !== existing.blockHash
    )
      throw new Error("Historical observation changed block hash");
    keyed.set(key, row);
  }
  return observatoryDatasetSchema.parse({
    ...next,
    rows: [...keyed.values()].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    ),
  }) as ObservatoryDatasetFor<F>;
}

export async function runObservatoryRefresh(
  options: ObservatoryRefreshOptions,
): Promise<ObservatoryManifest> {
  const now = (options.now ?? (() => new Date()))();
  if ((await options.client.getChainId()) !== 1)
    throw new Error("Observatory refresh requires Ethereum mainnet");
  const release = await resolveReleaseBlock(
    options.client,
    options.releaseBlock,
  );
  const generatedAt = now.toISOString();
  const sampleNumbers = [
    ...new Set([...(options.sampleBlocks ?? []), release.number]),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (
    sampleNumbers.length > 400 ||
    sampleNumbers.some((block) => block > release.number || block < 22_889_951n)
  )
    throw new Error(
      "Historical samples must be within the supported v5 epoch and end at the release block",
    );
  const previous = await readObservatoryManifest(options.outputDirectory);
  const previousData = new Map<ObservatoryFeed, ObservatoryDataset | null>();
  const blocks = new Map<string, Promise<ResolvedReleaseBlock>>();
  const spotSnapshots = new Map<string, Promise<SpotHealthDataset>>();
  const brokerSnapshots = new Map<string, Promise<BrokerStateDataset>>();
  const brokerPoints = new Map<string, Promise<BrokerHistoryPoint>>();
  const blockAt = (number: bigint) => {
    const key = number.toString();
    if (!blocks.has(key))
      blocks.set(
        key,
        number === release.number
          ? Promise.resolve(release)
          : resolveReleaseBlock(options.client, { number, expectedHash: null }),
      );
    return blocks.get(key)!;
  };
  const spotAt = (number: bigint) => {
    const key = number.toString();
    if (!spotSnapshots.has(key))
      spotSnapshots.set(
        key,
        blockAt(number).then((block) =>
          readSpotHealthDataset(
            options.client,
            block,
            generatedAt,
            options.implementationVerifier,
          ),
        ),
      );
    return spotSnapshots.get(key)!;
  };
  const brokerAt = (number: bigint) => {
    const key = number.toString();
    if (!brokerSnapshots.has(key))
      brokerSnapshots.set(
        key,
        blockAt(number).then((block) =>
          readBrokerStateDataset(
            options.client,
            block,
            generatedAt,
            options.implementationVerifier,
          ),
        ),
      );
    return brokerSnapshots.get(key)!;
  };
  const brokerPointAt = (number: bigint) => {
    const key = number.toString();
    if (!brokerPoints.has(key))
      brokerPoints.set(
        key,
        Promise.all([blockAt(number), brokerAt(number)]).then(
          ([block, state]) => brokerPoint(options.client, block, state),
        ),
      );
    return brokerPoints.get(key)!;
  };
  const legacy: Partial<
    Record<"ampl-rebases" | "spot-health" | "broker-state", unknown>
  > = {};
  const readers: Record<ObservatoryFeed, () => Promise<ObservatoryDataset>> = {
    "ampl-history": async () => {
      const ampl = await readAmplHistoryIncremental(
        options,
        release,
        generatedAt,
        options.previousAmpl,
      );
      legacy["ampl-rebases"] = ampl;
      return { ...envelope("ampl-history", generatedAt), rows: ampl.rows };
    },
    "spot-history": async () => {
      const rows: SpotHistoryPoint[] = [];
      for (const number of sampleNumbers) {
        const [block, spot, broker] = await Promise.all([
          blockAt(number),
          spotAt(number),
          brokerAt(number).catch(() => null),
        ]);
        rows.push({
          ...observation(block),
          implementation: {
            address: spot.spot.implementationAddress,
            codeHash: spot.spot.implementationCodeHash,
          },
          collateralAmpl: spot.spot.collateralTvl,
          totalSupply: spot.spot.totalSupply,
          deviationRatio: spot.rolloverVault.deviationRatio,
          deviationRatioDecimals: spot.rolloverVault.deviationRatioDecimals,
          fmvUsd: broker?.reserveState.spotPrice ?? null,
          reserveCount: spot.reserves.length.toString(),
        });
        if (number === release.number) legacy["spot-health"] = spot;
      }
      return mergeRows(
        "spot-history",
        previousData.get("spot-history") ?? null,
        { ...envelope("spot-history", generatedAt), rows },
      );
    },
    "broker-history": async () => {
      const rows: BrokerHistoryPoint[] = [];
      for (const number of sampleNumbers)
        rows.push(await brokerPointAt(number));
      legacy["broker-state"] = await brokerAt(release.number);
      const older = previousData.get("broker-history");
      const firstBlock =
        older?.feed === "broker-history" &&
        older.rows[0] !== undefined &&
        BigInt(older.rows[0].blockNumber) < sampleNumbers[0]!
          ? BigInt(older.rows[0].blockNumber)
          : sampleNumbers[0]!;
      const events = await readBrokerHistoryEvents(
        options,
        firstBlock + 1n,
        release.number,
      );
      const ledger = await readBrokerLedger({
        client: options.logClient ?? options.client,
        fromBlock: firstBlock,
        toBlock: release.number,
        operations: events,
        verifyBlock: (number) =>
          readVerifiedImplementation(
            options.client,
            number,
            "billBroker",
            options.implementationVerifier,
          ),
        verifyCanonicalBlock: (number, expectedHash) =>
          resolveReleaseBlock(options.client, { number, expectedHash }),
        ...(options.maximumLogRange === undefined
          ? {}
          : { maximumLogRange: options.maximumLogRange }),
        ...(options.maximumLogsPerResponse === undefined
          ? {}
          : { maximumLogsPerResponse: options.maximumLogsPerResponse }),
      });
      const merged = mergeRows(
        "broker-history",
        previousData.get("broker-history") ?? null,
        { ...envelope("broker-history", generatedAt), rows, events, ledger },
      );
      if (older?.feed === "broker-history") {
        const byId = new Map(
          [...older.events, ...events].map((event) => [
            `${event.transactionHash}:${event.logIndex}`,
            event,
          ]),
        );
        merged.events = [...byId.values()].sort(
          (a, b) =>
            a.timestamp.localeCompare(b.timestamp) ||
            Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
        );
      }
      merged.notes.push(
        "The ledger sums every observed reserve-token transfer and LP mint/burn in (fromBlock, toBlock]. Fee evidence is available only for unambiguous single-swap transactions.",
        "Transaction-level fees use emitted pre-operation prices and ordered token transfers under the recorded Broker bytecode. Complex transactions retain null fee attribution.",
      );
      return merged;
    },
    "stampl-history": async () => {
      const rows: StamplHistoryPoint[] = [];
      for (const number of sampleNumbers)
        rows.push(
          await stamplPoint(
            options,
            await blockAt(number),
            await spotAt(number),
          ),
        );
      const dataset = mergeRows(
        "stampl-history",
        previousData.get("stampl-history") ?? null,
        { ...envelope("stampl-history", generatedAt), rows },
      );
      dataset.notes.push(
        "Funding is the policy indication at observed TVLs, not realized income or a guaranteed next payment. Rebalance claims and melds fees before recomputing TVLs.",
        "Positive funding flows from stAMPL to SPOT; negative flows from SPOT to stAMPL. Rebalance requires not paused and block time strictly greater than last rebalance plus period.",
        "AMPL per stAMPL is underlying-denominated NAV, including rebase exposure; it is not USD performance or fee-only yield.",
      );
      return dataset;
    },
    collateral: async () => ({
      ...envelope("collateral", generatedAt),
      rows: [
        await collateralPoint(options, release, await spotAt(release.number)),
      ],
    }),
    "exit-inputs": async () => ({
      ...envelope("exit-inputs", generatedAt),
      rows: [
        await exitPoint(
          options,
          release,
          await spotAt(release.number),
          await brokerPointAt(release.number),
        ),
      ],
    }),
    "spot-market": async () => {
      const prior = previousData.get("spot-market");
      return (options.marketReader ?? readSpotMarketHistory)({
        client: options.client,
        logClient: options.logClient ?? options.client,
        release,
        now,
        previous: prior?.feed === "spot-market" ? prior : null,
        ...(options.historyDays === undefined
          ? {}
          : { historyDays: options.historyDays }),
      });
    },
  };
  const results = await Promise.all(
    (options.feeds ?? OBSERVATORY_FEEDS)
      .filter(
        (feed) => feed !== "spot-market" || options.includeMarket !== false,
      )
      .map(async (feed): Promise<FeedRefreshResult> => {
        options.onProgress?.({ feed, status: "started" });
        try {
          // Validate prior data inside this feed's failure boundary so an
          // unrelated broken feed cannot prevent the selected feeds from
          // updating.
          if (previous !== null)
            previousData.set(
              feed,
              await readPublishedFeed(
                options.outputDirectory,
                previous.feeds[feed],
              ),
            );
          const dataset = observatoryDatasetSchema.parse(await readers[feed]());
          if (dataset.rows.length === 0)
            throw new Error("No observations returned for this feed");
          options.onProgress?.({
            feed,
            status: "ok",
            rowCount: dataset.rows.length,
          });
          return { feed, dataset };
        } catch (error) {
          options.onProgress?.({ feed, status: "error" });
          return {
            feed,
            failure:
              error instanceof UnsupportedProtocolIntegrationError
                ? "implementation-unsupported"
                : feed === "spot-market"
                  ? "market-source-unavailable"
                  : "read-failed",
            status:
              error instanceof UnsupportedProtocolIntegrationError
                ? "unsupported"
                : "error",
          };
        }
      }),
  );
  // A canonicality failure invalidates every newly collected chain feed.
  for (const blockPromise of blocks.values())
    await verifyReleaseBlockCanonical(options.client, await blockPromise);
  await verifyReleaseBlockCanonical(options.client, release);
  return publishObservatoryRefresh(
    options.outputDirectory,
    generatedAt,
    results,
    legacy,
  );
}

/** Use real block timestamps to choose the last block at or before each UTC target. */
export async function sampleDailyBlocks(
  client: ObservatoryPublicClient,
  release: ResolvedReleaseBlock,
  days: number,
  intervalDays = 7,
): Promise<bigint[]> {
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > 365 ||
    !Number.isInteger(intervalDays) ||
    intervalDays < 1
  )
    throw new Error("Invalid sample window");
  const minimum = 22_889_951n;
  const minimumBlock = await client.getBlock({ blockNumber: minimum });
  const cache = new Map<string, bigint>([
    [minimum.toString(), minimumBlock.timestamp],
    [release.number.toString(), release.timestamp],
  ]);
  const sample = new Set<bigint>();
  for (let offset = days; offset > 0; offset -= intervalDays) {
    const target = release.timestamp - BigInt(offset * 86_400);
    if (target < minimumBlock.timestamp) continue;
    let low = minimum;
    let high = release.number;
    while (low < high) {
      const mid = (low + high + 1n) / 2n;
      let timestamp = cache.get(mid.toString());
      if (timestamp === undefined) {
        timestamp = (await client.getBlock({ blockNumber: mid })).timestamp;
        cache.set(mid.toString(), timestamp);
      }
      if (timestamp <= target) low = mid;
      else high = mid - 1n;
    }
    sample.add(low);
  }
  sample.add(release.number);
  return [...sample].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export type { AmplRebaseRow };
