import { join } from "node:path";

import { keccak256 } from "viem";

import {
  AMPL_POLICY_REBASE_EVENT,
  AMPL_POLICY_REBASE_V2_EVENT,
  AMPL_TOKEN_REBASE_EVENT,
  BILL_BROKER_ABI,
  BOND_ABI,
  CONTRACTS,
  EIP1967_IMPLEMENTATION_SLOT,
  ERC20_METADATA_ABI,
  MAINNET_CHAIN_ID,
  ROLLOVER_VAULT_ABI,
  SPOT_ABI,
  TRANCHE_ABI,
} from "./contracts";
import {
  DATA_SCHEMA_VERSION,
  amplRebasesDatasetSchema,
  brokerQuotesDatasetSchema,
  brokerStateDatasetSchema,
  evmAddressSchema,
  evmHashSchema,
  metaDatasetSchema,
  spotHealthDatasetSchema,
  type AmplRebaseRow,
  type AmplRebasesDataset,
  type BrokerQuote,
  type BrokerQuoteGridDefinition,
  type BrokerQuotesDataset,
  type BrokerStateDataset,
  type ContractReference,
  type DatasetMetadata,
  type LpRedemptionQuote,
  type MetaDataset,
  type SpotHealthDataset,
  type SpotReserve,
  type TokenDescriptor,
} from "./schemas";
import {
  atomicWriteTextFiles,
  stableCsvStringify,
  stableJsonStringify,
  type CsvColumn,
} from "./writers";

type EvmAddress = `0x${string}`;
type EvmHash = `0x${string}`;

export interface RpcBlock {
  readonly number: bigint | null;
  readonly hash: EvmHash | null;
  readonly timestamp: bigint;
}

export interface ObservatoryLogClient {
  getLogs(request: {
    readonly address: EvmAddress;
    readonly event: unknown;
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly strict?: boolean;
  }): Promise<readonly unknown[]>;
}

export interface ObservatoryPublicClient extends ObservatoryLogClient {
  getChainId(): Promise<number>;
  getBlock(
    request:
      | { readonly blockHash: EvmHash }
      | { readonly blockNumber: bigint },
  ): Promise<RpcBlock>;
  readContract(request: Readonly<Record<string, unknown>>): Promise<unknown>;
  getCode(request: {
    readonly address: EvmAddress;
    readonly blockNumber: bigint;
  }): Promise<`0x${string}` | undefined>;
  getStorageAt(request: {
    readonly address: EvmAddress;
    readonly blockNumber: bigint;
    readonly slot: `0x${string}`;
  }): Promise<`0x${string}` | undefined>;
}

export interface ReleaseBlockRequest {
  readonly number: bigint;
  readonly expectedHash: EvmHash | null;
}

export interface ResolvedReleaseBlock {
  readonly number: bigint;
  readonly hash: EvmHash;
  readonly timestamp: bigint;
  readonly timestampIso: string;
}

export interface AmplPolicyRebaseLog {
  readonly policySchema: "legacy" | "v2";
  readonly epoch: bigint;
  readonly exchangeRate: bigint;
  readonly cpiOracleValue: bigint | null;
  readonly emittedTargetRate: bigint | null;
  readonly requestedSupplyAdjustment: bigint;
  readonly timestamp: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: EvmHash;
  readonly transactionHash: EvmHash;
  readonly logIndex: bigint;
}

export interface AmplTokenRebaseLog {
  readonly epoch: bigint;
  readonly totalSupply: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: EvmHash;
  readonly transactionHash: EvmHash;
  readonly logIndex: bigint;
}

export interface AmplTargetRateResolver {
  resolveCpiAdjustedTargetRate(input: {
    readonly epoch: bigint;
    readonly blockNumber: bigint;
    readonly cpiOracleValue: bigint;
  }): Promise<bigint>;
}

export interface ProtocolImplementationVerifier {
  verifyImplementation(input: {
    readonly contract:
      | "billBroker"
      | "feePolicy"
      | "rolloverVault"
      | "spot";
    readonly blockNumber: bigint;
    readonly implementationAddress: EvmAddress;
    readonly runtimeCodeHash: EvmHash;
  }): Promise<void> | void;
}

export class UnsupportedProtocolIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedProtocolIntegrationError";
  }
}

export const unsupportedAmplTargetRateResolver: AmplTargetRateResolver = {
  async resolveCpiAdjustedTargetRate(): Promise<bigint> {
    throw new UnsupportedProtocolIntegrationError(
      "AMPL history spans policy versions with different CPI event semantics. " +
        "A version-aware AmplTargetRateResolver is needed to derive a target rate.",
    );
  },
};

export const unsupportedImplementationVerifier: ProtocolImplementationVerifier =
  {
    verifyImplementation({ contract }): never {
      throw new UnsupportedProtocolIntegrationError(
        `${contract} implementation identity is unsupported.`,
      );
    },
  };

/**
 * Default recorded-quote grid: quarter decades from one whole token, at most
 * 40 points per direction, stopping after two consecutive unavailable quotes;
 * LP amounts at 0.01% to 100% of LP supply. `release/refresh-config.json`
 * carries the value used for the committed release data.
 */
export const DEFAULT_BROKER_QUOTE_GRID: BrokerQuoteGridDefinition = {
  quarterDecadeMantissasThousandths: ["1000", "1778", "3162", "5623"],
  maximumPoints: 40,
  stopAfterUnavailable: 2,
  lpSupplyBasisPoints: [
    "1",
    "10",
    "50",
    "100",
    "200",
    "500",
    "1000",
    "2500",
    "5000",
    "10000",
  ],
};

export interface RefreshOptions {
  readonly client: ObservatoryPublicClient;
  readonly logClient?: ObservatoryLogClient;
  readonly releaseBlock: ReleaseBlockRequest;
  readonly outputDirectory: string;
  readonly targetRateResolver: AmplTargetRateResolver;
  readonly implementationVerifier: ProtocolImplementationVerifier;
  readonly now?: () => Date;
  readonly initialLogRange?: bigint;
  readonly maximumLogRange?: bigint;
  readonly maximumLogsPerResponse?: number;
  readonly brokerQuoteGrid?: BrokerQuoteGridDefinition;
}

export interface RefreshResult {
  readonly releaseBlock: ResolvedReleaseBlock;
  readonly files: readonly string[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label} response`);
  }
  return value as Record<string, unknown>;
}

function asBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return BigInt(value);
  }
  throw new Error(`Invalid integer returned for ${label}`);
}

function asSignedBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  throw new Error(`Invalid signed integer returned for ${label}`);
}

function asAddress(value: unknown, label: string): EvmAddress {
  const parsed = evmAddressSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid address returned for ${label}`);
  }
  return parsed.data as EvmAddress;
}

function asHash(value: unknown, label: string): EvmHash {
  const parsed = evmHashSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid hash returned for ${label}`);
  }
  return parsed.data as EvmHash;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid string returned for ${label}`);
  }
  return value;
}

function unixSecondsToIso(value: bigint): string {
  if (
    value < 0n ||
    value > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))
  ) {
    throw new Error("EVM timestamp is outside the supported ISO date range");
  }
  const date = new Date(Number(value) * 1_000);
  if (Number.isNaN(date.getTime())) {
    throw new Error("EVM timestamp cannot be represented as an ISO date");
  }
  return date.toISOString();
}

function decimalRatio(
  numerator: bigint,
  denominator: bigint,
  decimalPlaces = 18,
): string {
  if (denominator <= 0n) {
    throw new Error("A decimal ratio requires a positive denominator");
  }
  const negative = numerator < 0n;
  const absoluteNumerator = negative ? -numerator : numerator;
  const whole = absoluteNumerator / denominator;
  const remainder = absoluteNumerator % denominator;
  if (remainder === 0n || decimalPlaces === 0) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }
  const scale = 10n ** BigInt(decimalPlaces);
  const fraction = ((remainder * scale) / denominator)
    .toString()
    .padStart(decimalPlaces, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${
    fraction.length > 0 ? `.${fraction}` : ""
  }`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contractReference(
  contract: (typeof CONTRACTS)[keyof typeof CONTRACTS],
): ContractReference {
  return {
    role: contract.role,
    address: contract.address,
    deploymentBlock:
      contract.deploymentBlock === null
        ? null
        : contract.deploymentBlock.toString(),
  };
}

function metadataFor(
  dataset: DatasetMetadata["dataset"],
  releaseBlock: ResolvedReleaseBlock,
  generatedAt: string,
  contracts: readonly (keyof typeof CONTRACTS)[],
  notes: readonly string[],
): DatasetMetadata {
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    dataset,
    status: "release",
    generatedAt,
    chainId: MAINNET_CHAIN_ID,
    blockNumber: releaseBlock.number.toString(),
    blockHash: releaseBlock.hash,
    blockTimestamp: releaseBlock.timestampIso,
    provenance: {
      kind: "ethereum-rpc",
      generator: "scripts/refresh.ts",
      contracts: contracts.map((name) => contractReference(CONTRACTS[name])),
      notes: [...notes],
    },
  };
}

export function parseReleaseBlockRequest(
  releaseBlock: string | undefined,
  releaseBlockHash?: string | undefined,
): ReleaseBlockRequest {
  if (releaseBlock === undefined || releaseBlock.length === 0) {
    throw new Error("RELEASE_BLOCK is required");
  }

  const match = /^(0|[1-9][0-9]*)(?:@(0x[0-9a-fA-F]{64}))?$/.exec(
    releaseBlock,
  );
  if (match === null || match[1] === undefined) {
    throw new Error(
      "RELEASE_BLOCK must be a base-10 block number or number@blockHash",
    );
  }
  const number = BigInt(match[1]);
  if (number === 0n) {
    throw new Error("RELEASE_BLOCK must be positive");
  }

  const inlineHash = match[2] ?? null;
  const separateHash =
    releaseBlockHash === undefined || releaseBlockHash.length === 0
      ? null
      : evmHashSchema.parse(releaseBlockHash);
  if (
    inlineHash !== null &&
    separateHash !== null &&
    inlineHash.toLowerCase() !== separateHash.toLowerCase()
  ) {
    throw new Error(
      "The inline RELEASE_BLOCK hash does not match RELEASE_BLOCK_HASH",
    );
  }

  return {
    number,
    expectedHash: (inlineHash ?? separateHash) as EvmHash | null,
  };
}

export async function resolveReleaseBlock(
  client: ObservatoryPublicClient,
  request: ReleaseBlockRequest,
): Promise<ResolvedReleaseBlock> {
  const block = await client.getBlock({ blockNumber: request.number });
  if (block.number !== request.number || block.hash === null) {
    throw new Error("RPC did not return the requested complete release block");
  }
  const hash = asHash(block.hash, "release block");
  if (
    request.expectedHash !== null &&
    hash.toLowerCase() !== request.expectedHash.toLowerCase()
  ) {
    throw new Error("Resolved release block hash does not match the expected hash");
  }

  const byHash = await client.getBlock({ blockHash: hash });
  if (
    byHash.number !== request.number ||
    byHash.hash === null ||
    byHash.hash.toLowerCase() !== hash.toLowerCase()
  ) {
    throw new Error("RPC could not verify the release block by hash");
  }

  return {
    number: request.number,
    hash,
    timestamp: block.timestamp,
    timestampIso: unixSecondsToIso(block.timestamp),
  };
}

export async function verifyReleaseBlockCanonical(
  client: ObservatoryPublicClient,
  releaseBlock: ResolvedReleaseBlock,
): Promise<void> {
  const current = await client.getBlock({ blockNumber: releaseBlock.number });
  if (
    current.hash === null ||
    current.hash.toLowerCase() !== releaseBlock.hash.toLowerCase()
  ) {
    throw new Error("Release block hash changed during refresh");
  }
}

export interface AdaptiveLogOptions {
  readonly client: ObservatoryLogClient;
  readonly address: EvmAddress;
  readonly event: unknown;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly initialRange?: bigint;
  readonly maximumRange?: bigint;
  readonly maximumLogsPerResponse?: number;
}

export async function fetchLogsAdaptive(
  options: AdaptiveLogOptions,
): Promise<readonly unknown[]> {
  if (options.fromBlock > options.toBlock) {
    return [];
  }
  const maximumRange = options.maximumRange ?? 250_000n;
  let range = options.initialRange ?? 50_000n;
  if (range <= 0n || maximumRange <= 0n) {
    throw new Error("Adaptive log ranges must be positive");
  }
  if (
    options.maximumLogsPerResponse !== undefined &&
    (!Number.isSafeInteger(options.maximumLogsPerResponse) ||
      options.maximumLogsPerResponse <= 0)
  ) {
    throw new Error("Maximum logs per response must be a positive integer");
  }
  range = range > maximumRange ? maximumRange : range;

  const logs: unknown[] = [];
  let cursor = options.fromBlock;
  while (cursor <= options.toBlock) {
    const remaining = options.toBlock - cursor + 1n;
    const attemptedRange = range < remaining ? range : remaining;
    const end = cursor + attemptedRange - 1n;
    try {
      const page = await options.client.getLogs({
        address: options.address,
        event: options.event,
        fromBlock: cursor,
        toBlock: end,
        strict: true,
      });
      if (
        options.maximumLogsPerResponse !== undefined &&
        page.length >= options.maximumLogsPerResponse
      ) {
        throw new Error(
          `RPC log response reached the configured limit of ${options.maximumLogsPerResponse.toString()}`,
        );
      }
      logs.push(...page);
      cursor = end + 1n;
      range =
        attemptedRange < maximumRange
          ? attemptedRange * 2n > maximumRange
            ? maximumRange
            : attemptedRange * 2n
          : maximumRange;
    } catch (error) {
      if (attemptedRange === 1n) {
        throw new Error(
          `RPC rejected the required single-block log query at block ${cursor.toString()}`,
          { cause: error },
        );
      }
      range = attemptedRange / 2n;
      if (range === 0n) {
        range = 1n;
      }
    }
  }
  return logs;
}

function logField(record: Record<string, unknown>, key: string): unknown {
  if (!(key in record)) {
    throw new Error(`RPC log is missing ${key}`);
  }
  return record[key];
}

export function normalizeAmplPolicyLog(rawLog: unknown): AmplPolicyRebaseLog {
  const log = asRecord(rawLog, "AMPL policy log");
  const args = asRecord(logField(log, "args"), "AMPL policy log arguments");
  return {
    policySchema: "legacy",
    epoch: asBigInt(logField(args, "epoch"), "AMPL policy epoch"),
    exchangeRate: asBigInt(
      logField(args, "exchangeRate"),
      "AMPL exchange rate",
    ),
    cpiOracleValue: asBigInt(logField(args, "cpi"), "AMPL CPI oracle value"),
    emittedTargetRate: null,
    requestedSupplyAdjustment: asSignedBigInt(
      logField(args, "requestedSupplyAdjustment"),
      "AMPL requested supply adjustment",
    ),
    timestamp: asBigInt(
      logField(args, "timestampSec"),
      "AMPL rebase timestamp",
    ),
    blockNumber: asBigInt(
      logField(log, "blockNumber"),
      "AMPL policy block number",
    ),
    blockHash: asHash(logField(log, "blockHash"), "AMPL policy block"),
    transactionHash: asHash(
      logField(log, "transactionHash"),
      "AMPL policy transaction",
    ),
    logIndex: asBigInt(logField(log, "logIndex"), "AMPL policy log index"),
  };
}

export function normalizeAmplPolicyV2Log(
  rawLog: unknown,
  blockTimestamp: bigint,
): AmplPolicyRebaseLog {
  const log = asRecord(rawLog, "AMPL V2 policy log");
  const args = asRecord(logField(log, "args"), "AMPL V2 policy log arguments");
  return {
    policySchema: "v2",
    epoch: asBigInt(logField(args, "epoch"), "AMPL V2 policy epoch"),
    exchangeRate: asBigInt(
      logField(args, "exchangeRate"),
      "AMPL V2 exchange rate",
    ),
    cpiOracleValue: null,
    emittedTargetRate: asBigInt(
      logField(args, "targetRate"),
      "AMPL V2 target rate",
    ),
    requestedSupplyAdjustment: asSignedBigInt(
      logField(args, "requestedSupplyAdjustment"),
      "AMPL V2 requested supply adjustment",
    ),
    timestamp: blockTimestamp,
    blockNumber: asBigInt(
      logField(log, "blockNumber"),
      "AMPL V2 policy block number",
    ),
    blockHash: asHash(logField(log, "blockHash"), "AMPL V2 policy block"),
    transactionHash: asHash(
      logField(log, "transactionHash"),
      "AMPL V2 policy transaction",
    ),
    logIndex: asBigInt(logField(log, "logIndex"), "AMPL V2 policy log index"),
  };
}

export function normalizeAmplTokenLog(rawLog: unknown): AmplTokenRebaseLog {
  const log = asRecord(rawLog, "AMPL token log");
  const args = asRecord(logField(log, "args"), "AMPL token log arguments");
  return {
    epoch: asBigInt(logField(args, "epoch"), "AMPL token epoch"),
    totalSupply: asBigInt(
      logField(args, "totalSupply"),
      "AMPL total supply",
    ),
    blockNumber: asBigInt(
      logField(log, "blockNumber"),
      "AMPL token block number",
    ),
    blockHash: asHash(logField(log, "blockHash"), "AMPL token block"),
    transactionHash: asHash(
      logField(log, "transactionHash"),
      "AMPL token transaction",
    ),
    logIndex: asBigInt(logField(log, "logIndex"), "AMPL token log index"),
  };
}

function comparePolicyLogs(
  left: AmplPolicyRebaseLog,
  right: AmplPolicyRebaseLog,
): number {
  const fields = ["epoch", "blockNumber"] as const;
  for (const field of fields) {
    if (left[field] < right[field]) {
      return -1;
    }
    if (left[field] > right[field]) {
      return 1;
    }
  }
  const transactionCompared = compareText(
    left.transactionHash.toLowerCase(),
    right.transactionHash.toLowerCase(),
  );
  if (transactionCompared !== 0) {
    return transactionCompared;
  }
  return left.logIndex < right.logIndex
    ? -1
    : left.logIndex > right.logIndex
      ? 1
      : 0;
}

function sameTokenRebase(
  left: AmplTokenRebaseLog,
  right: AmplTokenRebaseLog,
): boolean {
  return (
    left.epoch === right.epoch &&
    left.totalSupply === right.totalSupply &&
    left.blockNumber === right.blockNumber &&
    left.blockHash.toLowerCase() === right.blockHash.toLowerCase() &&
    left.transactionHash.toLowerCase() === right.transactionHash.toLowerCase()
  );
}

function samePolicyRebase(
  left: AmplPolicyRebaseLog,
  right: AmplPolicyRebaseLog,
): boolean {
  return (
    left.policySchema === right.policySchema &&
    left.epoch === right.epoch &&
    left.exchangeRate === right.exchangeRate &&
    left.cpiOracleValue === right.cpiOracleValue &&
    left.emittedTargetRate === right.emittedTargetRate &&
    left.requestedSupplyAdjustment === right.requestedSupplyAdjustment &&
    left.timestamp === right.timestamp &&
    left.blockNumber === right.blockNumber &&
    left.blockHash.toLowerCase() === right.blockHash.toLowerCase() &&
    left.transactionHash.toLowerCase() === right.transactionHash.toLowerCase()
  );
}

export async function pairAmplRebaseLogs(
  policyLogs: readonly AmplPolicyRebaseLog[],
  tokenLogs: readonly AmplTokenRebaseLog[],
  targetRateResolver: AmplTargetRateResolver,
): Promise<AmplRebaseRow[]> {
  const tokenByEpoch = new Map<string, AmplTokenRebaseLog>();
  for (const tokenLog of tokenLogs) {
    const epoch = tokenLog.epoch.toString();
    const existing = tokenByEpoch.get(epoch);
    if (existing !== undefined) {
      if (!sameTokenRebase(existing, tokenLog)) {
        throw new Error(
          `Conflicting AMPL token rebase events for epoch ${epoch}`,
        );
      }
      if (tokenLog.logIndex < existing.logIndex) {
        tokenByEpoch.set(epoch, tokenLog);
      }
      continue;
    }
    tokenByEpoch.set(epoch, tokenLog);
  }

  const sortedPolicyLogs = [...policyLogs].sort(comparePolicyLogs);
  const policyByEpoch = new Map<string, AmplPolicyRebaseLog>();
  for (const policyLog of sortedPolicyLogs) {
    const epoch = policyLog.epoch.toString();
    const existing = policyByEpoch.get(epoch);
    if (existing !== undefined) {
      if (!samePolicyRebase(existing, policyLog)) {
        throw new Error(
          `Conflicting AMPL policy rebase events for epoch ${epoch}`,
        );
      }
      continue;
    }
    policyByEpoch.set(epoch, policyLog);
  }
  const uniquePolicyLogs = [...policyByEpoch.values()];
  const seenPolicyEpochs = new Set<string>();
  const paired: Array<{
    readonly policy: AmplPolicyRebaseLog;
    readonly token: AmplTokenRebaseLog;
    readonly targetRate: bigint;
  }> = [];

  for (const policy of uniquePolicyLogs) {
    const epoch = policy.epoch.toString();
    seenPolicyEpochs.add(epoch);
    const token = tokenByEpoch.get(epoch);
    if (token === undefined) {
      throw new Error(`Missing AMPL token rebase event for epoch ${epoch}`);
    }
    if (
      token.blockNumber !== policy.blockNumber ||
      token.blockHash.toLowerCase() !== policy.blockHash.toLowerCase() ||
      token.transactionHash.toLowerCase() !==
        policy.transactionHash.toLowerCase()
    ) {
      throw new Error(`AMPL rebase events disagree for epoch ${epoch}`);
    }
    let targetRate: bigint;
    if (policy.policySchema === "v2") {
      if (policy.emittedTargetRate === null) {
        throw new Error(`Missing AMPL V2 target rate for epoch ${epoch}`);
      }
      targetRate = policy.emittedTargetRate;
    } else {
      if (policy.cpiOracleValue === null) {
        throw new Error(`Missing legacy AMPL CPI value for epoch ${epoch}`);
      }
      targetRate = await targetRateResolver.resolveCpiAdjustedTargetRate({
        epoch: policy.epoch,
        blockNumber: policy.blockNumber,
        cpiOracleValue: policy.cpiOracleValue,
      });
    }
    if (targetRate < 0n) {
      throw new Error(`Negative AMPL target rate for epoch ${epoch}`);
    }
    paired.push({ policy, token, targetRate });
  }

  if (paired.length !== tokenByEpoch.size) {
    const unpaired = [...tokenByEpoch.keys()].filter(
      (epoch) => !seenPolicyEpochs.has(epoch),
    );
    throw new Error(
      `Missing AMPL policy rebase event for epoch ${unpaired[0] ?? "unknown"}`,
    );
  }

  return paired.map((entry, index) => {
    const previous = index === 0 ? null : paired[index - 1]?.token.totalSupply;
    const supplyChangePercent =
      previous === null || previous === undefined || previous === 0n
        ? null
        : decimalRatio(
            (entry.token.totalSupply - previous) * 100n,
            previous,
          );
    return {
      epoch: entry.policy.epoch.toString(),
      timestamp: unixSecondsToIso(entry.policy.timestamp),
      blockNumber: entry.policy.blockNumber.toString(),
      blockHash: entry.policy.blockHash,
      transactionHash: entry.policy.transactionHash,
      logIndex: entry.policy.logIndex.toString(),
      tokenLogIndex: entry.token.logIndex.toString(),
      policySchema: entry.policy.policySchema,
      exchangeRate: entry.policy.exchangeRate.toString(),
      cpiOracleValue: entry.policy.cpiOracleValue?.toString() ?? null,
      cpiAdjustedTargetRate: entry.targetRate.toString(),
      requestedSupplyAdjustment:
        entry.policy.requestedSupplyAdjustment.toString(),
      totalSupply: entry.token.totalSupply.toString(),
      previousTotalSupply: previous?.toString() ?? null,
      supplyChangePercent,
    };
  });
}

async function readContract<T>(
  client: ObservatoryPublicClient,
  request: {
    readonly address: EvmAddress;
    readonly abi: unknown;
    readonly functionName: string;
    readonly blockNumber: bigint;
    readonly args?: readonly unknown[];
  },
): Promise<T> {
  const parameters: Record<string, unknown> = {
    address: request.address,
    abi: request.abi,
    functionName: request.functionName,
    blockNumber: request.blockNumber,
  };
  if (request.args !== undefined) {
    parameters.args = request.args;
  }
  return (await client.readContract(parameters)) as T;
}

async function readProxyImplementation(
  client: ObservatoryPublicClient,
  proxyAddress: EvmAddress,
  blockNumber: bigint,
): Promise<{
  readonly address: EvmAddress;
  readonly codeHash: EvmHash;
}> {
  const storage = await client.getStorageAt({
    address: proxyAddress,
    blockNumber,
    slot: EIP1967_IMPLEMENTATION_SLOT,
  });
  if (
    storage === undefined ||
    !/^0x[0-9a-fA-F]{64}$/.test(storage)
  ) {
    throw new UnsupportedProtocolIntegrationError(
      "The EIP-1967 implementation slot is unavailable at the release block.",
    );
  }
  const address = asAddress(
    `0x${storage.slice(-40)}`,
    "proxy implementation",
  );
  if (/^0x0{40}$/i.test(address)) {
    throw new UnsupportedProtocolIntegrationError(
      "The EIP-1967 implementation slot contains the zero address.",
    );
  }
  const code = await client.getCode({ address, blockNumber });
  if (code === undefined || code === "0x") {
    throw new Error("Proxy implementation has no bytecode at the release block");
  }
  return {
    address,
    codeHash: keccak256(code) as EvmHash,
  };
}

async function optionalMetadataString(
  client: ObservatoryPublicClient,
  address: EvmAddress,
  functionName: "name" | "symbol",
  blockNumber: bigint,
): Promise<string | null> {
  try {
    return asString(
      await readContract(client, {
        address,
        abi: ERC20_METADATA_ABI,
        functionName,
        blockNumber,
      }),
      `${functionName} metadata`,
    );
  } catch {
    return null;
  }
}

async function readTokenDescriptor(
  client: ObservatoryPublicClient,
  address: EvmAddress,
  blockNumber: bigint,
): Promise<TokenDescriptor> {
  const [name, symbol, decimals] = await Promise.all([
    optionalMetadataString(client, address, "name", blockNumber),
    optionalMetadataString(client, address, "symbol", blockNumber),
    readContract<unknown>(client, {
      address,
      abi: ERC20_METADATA_ABI,
      functionName: "decimals",
      blockNumber,
    }),
  ]);
  return {
    address,
    name,
    symbol,
    decimals: asBigInt(decimals, "ERC-20 decimals").toString(),
  };
}

function decodeRange(
  value: unknown,
  label: string,
): readonly [bigint, bigint] {
  if (Array.isArray(value) && value.length >= 2) {
    return [
      asBigInt(value[0], `${label} lower`),
      asBigInt(value[1], `${label} upper`),
    ];
  }
  const range = asRecord(value, label);
  return [
    asBigInt(range.lower, `${label} lower`),
    asBigInt(range.upper, `${label} upper`),
  ];
}

interface DecodedReserveState {
  readonly usdBalance: bigint;
  readonly perpBalance: bigint;
  readonly usdPrice: bigint;
  readonly perpPrice: bigint;
}

function decodeReserveState(value: unknown): DecodedReserveState {
  if (Array.isArray(value) && value.length >= 4) {
    return {
      usdBalance: asBigInt(value[0], "broker USD balance"),
      perpBalance: asBigInt(value[1], "broker SPOT balance"),
      usdPrice: asBigInt(value[2], "broker USD price"),
      perpPrice: asBigInt(value[3], "broker SPOT price"),
    };
  }
  const state = asRecord(value, "Bill Broker reserve state");
  return {
    usdBalance: asBigInt(state.usdBalance, "broker USD balance"),
    perpBalance: asBigInt(state.perpBalance, "broker SPOT balance"),
    usdPrice: asBigInt(state.usdPrice, "broker USD price"),
    perpPrice: asBigInt(state.perpPrice, "broker SPOT price"),
  };
}

function reserveStateArgument(state: DecodedReserveState) {
  return {
    usdBalance: state.usdBalance,
    perpBalance: state.perpBalance,
    usdPrice: state.usdPrice,
    perpPrice: state.perpPrice,
  };
}

interface DecodedBrokerFees {
  readonly mintFee: bigint;
  readonly burnFee: bigint;
  readonly perpToUsd: readonly [bigint, bigint];
  readonly usdToPerp: readonly [bigint, bigint];
  readonly protocolShare: bigint;
}

function decodeBrokerFees(value: unknown): DecodedBrokerFees {
  if (Array.isArray(value) && value.length >= 5) {
    return {
      mintFee: asBigInt(value[0], "broker mint fee"),
      burnFee: asBigInt(value[1], "broker burn fee"),
      perpToUsd: decodeRange(value[2], "broker SPOT-to-USD fee factors"),
      usdToPerp: decodeRange(value[3], "broker USD-to-SPOT fee factors"),
      protocolShare: asBigInt(value[4], "broker protocol fee share"),
    };
  }
  const fees = asRecord(value, "Bill Broker fees");
  return {
    mintFee: asBigInt(fees.mintFeePerc, "broker mint fee"),
    burnFee: asBigInt(fees.burnFeePerc, "broker burn fee"),
    perpToUsd: decodeRange(
      fees.perpToUSDSwapFeeFactors,
      "broker SPOT-to-USD fee factors",
    ),
    usdToPerp: decodeRange(
      fees.usdToPerpSwapFeeFactors,
      "broker USD-to-SPOT fee factors",
    ),
    protocolShare: asBigInt(
      fees.protocolSwapSharePerc,
      "broker protocol fee share",
    ),
  };
}

function decodePair(value: unknown, label: string): readonly [bigint, bigint] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`Invalid ${label} response`);
  }
  return [
    asBigInt(value[0], `${label} output`),
    asBigInt(value[1], `${label} protocol fee`),
  ];
}

function isContractRevert(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (
    current !== null &&
    typeof current === "object" &&
    !visited.has(current)
  ) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const message =
      typeof record.shortMessage === "string"
        ? record.shortMessage
        : typeof record.message === "string"
          ? record.message
          : "";
    if (/revert/i.test(name) || /\brevert(?:ed)?\b/i.test(message)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

async function readBrokerQuote(
  client: ObservatoryPublicClient,
  request: {
    readonly brokerAddress: EvmAddress;
    readonly functionName:
      | "computePerpToUSDSwapAmt"
      | "computeUSDToPerpSwapAmt";
    readonly inputAsset: EvmAddress;
    readonly outputAsset: EvmAddress;
    readonly inputAmount: bigint;
    readonly state: DecodedReserveState;
    readonly blockNumber: bigint;
  },
): Promise<BrokerQuote> {
  try {
    const [outputAmount, protocolFeeAmount] = decodePair(
      await readContract(client, {
        address: request.brokerAddress,
        abi: BILL_BROKER_ABI,
        functionName: request.functionName,
        args: [request.inputAmount, reserveStateArgument(request.state)],
        blockNumber: request.blockNumber,
      }),
      request.functionName,
    );
    if (outputAmount === 0n) {
      // The contract answered with nothing out. Whether the size exceeded what
      // the reserves allow or the amount rounded to zero is not recorded;
      // only the observed zero output is.
      return {
        inputAsset: request.inputAsset,
        outputAsset: request.outputAsset,
        inputAmount: request.inputAmount.toString(),
        available: false,
        outputAmount: null,
        protocolFeeAmount: null,
        unavailableReason: "zero-output",
      };
    }
    return {
      inputAsset: request.inputAsset,
      outputAsset: request.outputAsset,
      inputAmount: request.inputAmount.toString(),
      available: true,
      outputAmount: outputAmount.toString(),
      protocolFeeAmount: protocolFeeAmount.toString(),
      unavailableReason: null,
    };
  } catch (error) {
    if (!isContractRevert(error)) {
      throw error;
    }
    return {
      inputAsset: request.inputAsset,
      outputAsset: request.outputAsset,
      inputAmount: request.inputAmount.toString(),
      available: false,
      outputAmount: null,
      protocolFeeAmount: null,
      unavailableReason: "contract-reverted",
    };
  }
}

async function readBondMetadata(
  client: ObservatoryPublicClient,
  tokenAddress: EvmAddress,
  blockNumber: bigint,
): Promise<{
  readonly bondAddress: EvmAddress;
  readonly maturityTimestamp: bigint;
} | null> {
  try {
    const bondAddress = asAddress(
      await readContract(client, {
        address: tokenAddress,
        abi: TRANCHE_ABI,
        functionName: "bond",
        blockNumber,
      }),
      "tranche bond",
    );
    const maturityTimestamp = asBigInt(
      await readContract(client, {
        address: bondAddress,
        abi: BOND_ABI,
        functionName: "maturityDate",
        blockNumber,
      }),
      "bond maturity",
    );
    return { bondAddress, maturityTimestamp };
  } catch {
    return null;
  }
}

async function readSpotReserve(
  client: ObservatoryPublicClient,
  tokenAddress: EvmAddress,
  underlyingAddress: EvmAddress,
  blockNumber: bigint,
): Promise<SpotReserve> {
  const [token, balanceValue, underlyingValueValue] = await Promise.all([
    readTokenDescriptor(client, tokenAddress, blockNumber),
    readContract(client, {
      address: CONTRACTS.spot.address,
      abi: SPOT_ABI,
      functionName: "getReserveTokenBalance",
      args: [tokenAddress],
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.spot.address,
      abi: SPOT_ABI,
      functionName: "getReserveTokenValue",
      args: [tokenAddress],
      blockNumber,
    }),
  ]);
  const isUnderlying =
    tokenAddress.toLowerCase() === underlyingAddress.toLowerCase();
  const bondMetadata = isUnderlying
    ? null
    : await readBondMetadata(client, tokenAddress, blockNumber);
  return {
    token,
    balance: asBigInt(balanceValue, "SPOT reserve balance").toString(),
    underlyingValue: asBigInt(
      underlyingValueValue,
      "SPOT reserve underlying value",
    ).toString(),
    isUnderlying,
    bondAddress: bondMetadata?.bondAddress ?? null,
    maturityTimestamp: bondMetadata?.maturityTimestamp.toString() ?? null,
    maturity:
      bondMetadata === null
        ? null
        : unixSecondsToIso(bondMetadata.maturityTimestamp),
  };
}

export async function readSpotHealthDataset(
  client: ObservatoryPublicClient,
  releaseBlock: ResolvedReleaseBlock,
  generatedAt: string,
  implementationVerifier: ProtocolImplementationVerifier =
    unsupportedImplementationVerifier,
): Promise<SpotHealthDataset> {
  const blockNumber = releaseBlock.number;
  const [spotImplementation, vaultImplementation, feePolicyImplementation] =
    await Promise.all([
      readProxyImplementation(client, CONTRACTS.spot.address, blockNumber),
      readProxyImplementation(
        client,
        CONTRACTS.rolloverVault.address,
        blockNumber,
      ),
      readProxyImplementation(
        client,
        CONTRACTS.spotFeePolicy.address,
        blockNumber,
      ),
    ]);
  await Promise.all([
    implementationVerifier.verifyImplementation({
      contract: "spot",
      blockNumber,
      implementationAddress: spotImplementation.address,
      runtimeCodeHash: spotImplementation.codeHash,
    }),
    implementationVerifier.verifyImplementation({
      contract: "rolloverVault",
      blockNumber,
      implementationAddress: vaultImplementation.address,
      runtimeCodeHash: vaultImplementation.codeHash,
    }),
    implementationVerifier.verifyImplementation({
      contract: "feePolicy",
      blockNumber,
      implementationAddress: feePolicyImplementation.address,
      runtimeCodeHash: feePolicyImplementation.codeHash,
    }),
  ]);
  const [
    reserveCountValue,
    underlyingValue,
    spotTvlValue,
    spotSupplyValue,
    vaultDeviationValue,
    vaultTvlValue,
    vaultSupplyValue,
    deviationDecimalsValue,
  ] = await Promise.all([
    readContract(client, {
      address: CONTRACTS.spot.address,
      abi: SPOT_ABI,
      functionName: "getReserveCount",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.spot.address,
      abi: SPOT_ABI,
      functionName: "underlying",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.spot.address,
      abi: SPOT_ABI,
      functionName: "getTVL",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.spot.address,
      abi: SPOT_ABI,
      functionName: "totalSupply",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.rolloverVault.address,
      abi: ROLLOVER_VAULT_ABI,
      functionName: "deviationRatio",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.rolloverVault.address,
      abi: ROLLOVER_VAULT_ABI,
      functionName: "getTVL",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.rolloverVault.address,
      abi: ROLLOVER_VAULT_ABI,
      functionName: "totalSupply",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.spotFeePolicy.address,
      abi: ERC20_METADATA_ABI,
      functionName: "decimals",
      blockNumber,
    }),
  ]);

  const reserveCount = asBigInt(reserveCountValue, "SPOT reserve count");
  if (reserveCount > 256n) {
    throw new Error("SPOT reserve count exceeds the tooling safety limit");
  }
  const underlying = asAddress(underlyingValue, "SPOT underlying");
  const reserveAddresses = await Promise.all(
    Array.from({ length: Number(reserveCount) }, async (_, index) =>
      asAddress(
        await readContract(client, {
          address: CONTRACTS.spot.address,
          abi: SPOT_ABI,
          functionName: "getReserveAt",
          args: [BigInt(index)],
          blockNumber,
        }),
        `SPOT reserve ${index}`,
      ),
    ),
  );
  const reserves = await Promise.all(
    reserveAddresses.map((address) =>
      readSpotReserve(client, address, underlying, blockNumber),
    ),
  );
  reserves.sort((left, right) =>
    compareText(
      left.token.address.toLowerCase(),
      right.token.address.toLowerCase(),
    ),
  );

  const spotTvl = asBigInt(spotTvlValue, "SPOT collateral TVL");
  const spotSupply = asBigInt(spotSupplyValue, "SPOT total supply");
  return spotHealthDatasetSchema.parse({
    metadata: metadataFor(
      "spot-health",
      releaseBlock,
      generatedAt,
      ["spot", "rolloverVault", "spotFeePolicy"],
      [
        "All contract values were read with eth_call at the release block.",
        "Reserve token and bond maturity metadata is discovered dynamically where supported.",
      ],
    ),
    rolloverVault: {
      address: CONTRACTS.rolloverVault.address,
      deviationRatio: asBigInt(
        vaultDeviationValue,
        "RolloverVault deviation ratio",
      ).toString(),
      deviationRatioDecimals: asBigInt(
        deviationDecimalsValue,
        "SPOT FeePolicy decimals",
      ).toString(),
      tvl: asBigInt(vaultTvlValue, "RolloverVault TVL").toString(),
      totalSupply: asBigInt(
        vaultSupplyValue,
        "RolloverVault total supply",
      ).toString(),
    },
    spot: {
      address: CONTRACTS.spot.address,
      implementationAddress: spotImplementation.address,
      implementationCodeHash: spotImplementation.codeHash,
      collateralTvl: spotTvl.toString(),
      totalSupply: spotSupply.toString(),
      collateralCoverage:
        spotSupply === 0n ? null : decimalRatio(spotTvl, spotSupply),
      collateralCoverageNumerator: spotTvl.toString(),
      collateralCoverageDenominator: spotSupply.toString(),
    },
    reserves,
  });
}

export async function readBrokerStateDataset(
  client: ObservatoryPublicClient,
  releaseBlock: ResolvedReleaseBlock,
  generatedAt: string,
  implementationVerifier: ProtocolImplementationVerifier =
    unsupportedImplementationVerifier,
): Promise<BrokerStateDataset> {
  const blockNumber = releaseBlock.number;
  const implementation = await readProxyImplementation(
    client,
    CONTRACTS.billBroker.address,
    blockNumber,
  );
  await implementationVerifier.verifyImplementation({
    contract: "billBroker",
    blockNumber,
    implementationAddress: implementation.address,
    runtimeCodeHash: implementation.codeHash,
  });
  const [usdAddressValue, spotAddressValue] = await Promise.all([
    readContract(client, {
      address: CONTRACTS.billBroker.address,
      abi: BILL_BROKER_ABI,
      functionName: "usd",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.billBroker.address,
      abi: BILL_BROKER_ABI,
      functionName: "perp",
      blockNumber,
    }),
  ]);
  const usdAddress = asAddress(usdAddressValue, "Bill Broker USD token");
  const spotAddress = asAddress(spotAddressValue, "Bill Broker SPOT token");
  if (
    usdAddress.toLowerCase() !== CONTRACTS.usdc.address.toLowerCase() ||
    spotAddress.toLowerCase() !== CONTRACTS.spot.address.toLowerCase()
  ) {
    throw new Error("Bill Broker token addresses do not match canonical contracts");
  }

  const [
    usdToken,
    spotToken,
    reserveStateValue,
    decimalsValue,
    oneValue,
    softBoundsValue,
    hardBoundsValue,
    feesValue,
  ] = await Promise.all([
    readTokenDescriptor(client, usdAddress, blockNumber),
    readTokenDescriptor(client, spotAddress, blockNumber),
    readContract(client, {
      address: CONTRACTS.billBroker.address,
      abi: BILL_BROKER_ABI,
      functionName: "reserveState",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.billBroker.address,
      abi: BILL_BROKER_ABI,
      functionName: "decimals",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.billBroker.address,
      abi: BILL_BROKER_ABI,
      functionName: "ONE",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.billBroker.address,
      abi: BILL_BROKER_ABI,
      functionName: "arSoftBound",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.billBroker.address,
      abi: BILL_BROKER_ABI,
      functionName: "arHardBound",
      blockNumber,
    }),
    readContract(client, {
      address: CONTRACTS.billBroker.address,
      abi: BILL_BROKER_ABI,
      functionName: "fees",
      blockNumber,
    }),
  ]);

  const state = decodeReserveState(reserveStateValue);
  const stateArgument = reserveStateArgument(state);
  const [assetRatioValue, usdToSpot, spotToUsd] = await Promise.all([
    readContract(client, {
      address: CONTRACTS.billBroker.address,
      abi: BILL_BROKER_ABI,
      functionName: "assetRatio",
      args: [stateArgument],
      blockNumber,
    }),
    readBrokerQuote(client, {
      brokerAddress: CONTRACTS.billBroker.address,
      functionName: "computeUSDToPerpSwapAmt",
      inputAsset: usdAddress,
      outputAsset: spotAddress,
      inputAmount: 1_000_000n,
      state,
      blockNumber,
    }),
    readBrokerQuote(client, {
      brokerAddress: CONTRACTS.billBroker.address,
      functionName: "computePerpToUSDSwapAmt",
      inputAsset: spotAddress,
      outputAsset: usdAddress,
      inputAmount: 1_000_000_000n,
      state,
      blockNumber,
    }),
  ]);
  const [softLower, softUpper] = decodeRange(
    softBoundsValue,
    "Bill Broker soft asset-ratio bounds",
  );
  const [hardLower, hardUpper] = decodeRange(
    hardBoundsValue,
    "Bill Broker hard asset-ratio bounds",
  );
  const fees = decodeBrokerFees(feesValue);

  return brokerStateDatasetSchema.parse({
    metadata: metadataFor(
      "broker-state",
      releaseBlock,
      generatedAt,
      ["billBroker", "spot", "usdc"],
      [
        "State, parameters, and quotes were evaluated with eth_call at the release block.",
        "Quote inputs are fixed at 1000000 USDC base units and 1000000000 SPOT base units.",
      ],
    ),
    brokerAddress: CONTRACTS.billBroker.address,
    implementationAddress: implementation.address,
    implementationCodeHash: implementation.codeHash,
    usdToken,
    spotToken,
    reserveState: {
      usdBalance: state.usdBalance.toString(),
      spotBalance: state.perpBalance.toString(),
      usdPrice: state.usdPrice.toString(),
      spotPrice: state.perpPrice.toString(),
    },
    assetRatio: asBigInt(assetRatioValue, "Bill Broker asset ratio").toString(),
    parameters: {
      decimals: asBigInt(decimalsValue, "Bill Broker decimals").toString(),
      one: asBigInt(oneValue, "Bill Broker ONE").toString(),
      softAssetRatioBounds: {
        lower: softLower.toString(),
        upper: softUpper.toString(),
      },
      hardAssetRatioBounds: {
        lower: hardLower.toString(),
        upper: hardUpper.toString(),
      },
      fees: {
        mintFeePercent: fees.mintFee.toString(),
        burnFeePercent: fees.burnFee.toString(),
        spotToUsdFeeFactors: {
          lower: fees.perpToUsd[0].toString(),
          upper: fees.perpToUsd[1].toString(),
        },
        usdToSpotFeeFactors: {
          lower: fees.usdToPerp[0].toString(),
          upper: fees.usdToPerp[1].toString(),
        },
        protocolSwapSharePercent: fees.protocolShare.toString(),
      },
    },
    quotes: {
      usdToSpot,
      spotToUsd,
    },
  });
}

/** Grid sizes in base units: unit × mantissa/1000 × 10^decade, ascending. */
function* brokerGridAmounts(
  unit: bigint,
  definition: BrokerQuoteGridDefinition,
): Generator<bigint> {
  const mantissas = definition.quarterDecadeMantissasThousandths.map(BigInt);
  for (let decade = 0n; ; decade += 1n) {
    const scale = 10n ** decade;
    for (const mantissa of mantissas) {
      yield (unit * mantissa * scale) / 1000n;
    }
  }
}

async function readBrokerQuoteGrid(
  client: ObservatoryPublicClient,
  request: {
    readonly brokerAddress: EvmAddress;
    readonly functionName:
      | "computePerpToUSDSwapAmt"
      | "computeUSDToPerpSwapAmt";
    readonly inputAsset: EvmAddress;
    readonly outputAsset: EvmAddress;
    readonly unit: bigint;
    readonly state: DecodedReserveState;
    readonly blockNumber: bigint;
    readonly definition: BrokerQuoteGridDefinition;
  },
): Promise<BrokerQuote[]> {
  const quotes: BrokerQuote[] = [];
  let unavailableRun = 0;
  for (const inputAmount of brokerGridAmounts(
    request.unit,
    request.definition,
  )) {
    if (quotes.length >= request.definition.maximumPoints) {
      break;
    }
    const quote = await readBrokerQuote(client, {
      brokerAddress: request.brokerAddress,
      functionName: request.functionName,
      inputAsset: request.inputAsset,
      outputAsset: request.outputAsset,
      inputAmount,
      state: request.state,
      blockNumber: request.blockNumber,
    });
    quotes.push(quote);
    unavailableRun = quote.available ? 0 : unavailableRun + 1;
    if (unavailableRun >= request.definition.stopAfterUnavailable) {
      break;
    }
  }
  return quotes;
}

/**
 * Records `computeRedemptionAmts` for each LP amount and, when SPOT is
 * redeemed, the contract's own quote for selling all of it against the
 * reserves that remain after the withdrawal. The subtraction of the redeemed
 * amounts from the recorded reserves is the only arithmetic performed here.
 */
async function readLpRedemptionQuotes(
  client: ObservatoryPublicClient,
  request: {
    readonly brokerAddress: EvmAddress;
    readonly usdAddress: EvmAddress;
    readonly spotAddress: EvmAddress;
    readonly state: DecodedReserveState;
    readonly lpSupply: bigint;
    readonly lpDecimals: bigint;
    readonly blockNumber: bigint;
    readonly definition: BrokerQuoteGridDefinition;
  },
): Promise<LpRedemptionQuote[]> {
  const unit = 10n ** request.lpDecimals;
  const candidates = [
    unit,
    ...request.definition.lpSupplyBasisPoints.map(
      (basisPoints) => (request.lpSupply * BigInt(basisPoints)) / 10_000n,
    ),
  ];
  const amounts = [...new Set(candidates.map((amount) => amount.toString()))]
    .map(BigInt)
    .filter((amount) => amount > 0n && amount <= request.lpSupply)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (amounts.length === 0) {
    throw new Error("No LP redemption amount lies within the LP supply");
  }
  const redemptions: LpRedemptionQuote[] = [];
  for (const lpAmount of amounts) {
    let pair: readonly [bigint, bigint];
    try {
      pair = decodePair(
        await readContract(client, {
          address: request.brokerAddress,
          abi: BILL_BROKER_ABI,
          functionName: "computeRedemptionAmts",
          args: [lpAmount],
          blockNumber: request.blockNumber,
        }),
        "computeRedemptionAmts",
      );
    } catch (error) {
      if (!isContractRevert(error)) {
        throw error;
      }
      redemptions.push({
        lpAmount: lpAmount.toString(),
        available: false,
        usdOut: null,
        spotOut: null,
        unavailableReason: "contract-reverted",
        postWithdrawalReserves: null,
        sale: null,
      });
      continue;
    }
    const [usdOut, spotOut] = pair;
    if (usdOut > request.state.usdBalance || spotOut > request.state.perpBalance) {
      throw new Error(
        "computeRedemptionAmts returned more than the recorded reserves hold",
      );
    }
    const postState: DecodedReserveState = {
      usdBalance: request.state.usdBalance - usdOut,
      perpBalance: request.state.perpBalance - spotOut,
      usdPrice: request.state.usdPrice,
      perpPrice: request.state.perpPrice,
    };
    const sale =
      spotOut === 0n
        ? null
        : await readBrokerQuote(client, {
            brokerAddress: request.brokerAddress,
            functionName: "computePerpToUSDSwapAmt",
            inputAsset: request.spotAddress,
            outputAsset: request.usdAddress,
            inputAmount: spotOut,
            state: postState,
            blockNumber: request.blockNumber,
          });
    redemptions.push({
      lpAmount: lpAmount.toString(),
      available: true,
      usdOut: usdOut.toString(),
      spotOut: spotOut.toString(),
      unavailableReason: null,
      postWithdrawalReserves: {
        usdBalance: postState.usdBalance.toString(),
        spotBalance: postState.perpBalance.toString(),
      },
      sale,
    });
  }
  return redemptions;
}

/**
 * Records the Broker quote grids at the release block against the reserve
 * state already recorded in the broker-state dataset. The one-unit grid
 * points must reproduce the broker-state standard quotes exactly.
 */
export async function readBrokerQuotesDataset(
  client: ObservatoryPublicClient,
  releaseBlock: ResolvedReleaseBlock,
  generatedAt: string,
  broker: BrokerStateDataset,
  definition: BrokerQuoteGridDefinition = DEFAULT_BROKER_QUOTE_GRID,
): Promise<BrokerQuotesDataset> {
  const blockNumber = releaseBlock.number;
  const brokerAddress = evmAddressSchema.parse(broker.brokerAddress) as EvmAddress;
  const usdAddress = evmAddressSchema.parse(broker.usdToken.address) as EvmAddress;
  const spotAddress = evmAddressSchema.parse(broker.spotToken.address) as EvmAddress;
  const state: DecodedReserveState = {
    usdBalance: BigInt(broker.reserveState.usdBalance),
    perpBalance: BigInt(broker.reserveState.spotBalance),
    usdPrice: BigInt(broker.reserveState.usdPrice),
    perpPrice: BigInt(broker.reserveState.spotPrice),
  };
  const lpSupply = asBigInt(
    await readContract(client, {
      address: brokerAddress,
      abi: BILL_BROKER_ABI,
      functionName: "totalSupply",
      blockNumber,
    }),
    "Bill Broker LP supply",
  );
  const lpDecimals = BigInt(broker.parameters.decimals);
  const [spotToUsd, usdToSpot] = await Promise.all([
    readBrokerQuoteGrid(client, {
      brokerAddress,
      functionName: "computePerpToUSDSwapAmt",
      inputAsset: spotAddress,
      outputAsset: usdAddress,
      unit: 10n ** BigInt(broker.spotToken.decimals),
      state,
      blockNumber,
      definition,
    }),
    readBrokerQuoteGrid(client, {
      brokerAddress,
      functionName: "computeUSDToPerpSwapAmt",
      inputAsset: usdAddress,
      outputAsset: spotAddress,
      unit: 10n ** BigInt(broker.usdToken.decimals),
      state,
      blockNumber,
      definition,
    }),
  ]);
  for (const [label, grid, standard] of [
    ["SPOT to USDC", spotToUsd, broker.quotes.spotToUsd],
    ["USDC to SPOT", usdToSpot, broker.quotes.usdToSpot],
  ] as const) {
    const recorded = grid.find(
      (quote) => quote.inputAmount === standard.inputAmount,
    );
    if (
      recorded === undefined ||
      recorded.available !== standard.available ||
      recorded.outputAmount !== standard.outputAmount ||
      recorded.protocolFeeAmount !== standard.protocolFeeAmount
    ) {
      throw new Error(
        `The one-unit ${label} grid quote does not reproduce the broker-state standard quote`,
      );
    }
  }
  const lpRedemptions = await readLpRedemptionQuotes(client, {
    brokerAddress,
    usdAddress,
    spotAddress,
    state,
    lpSupply,
    lpDecimals,
    blockNumber,
    definition,
  });
  return brokerQuotesDatasetSchema.parse({
    metadata: metadataFor(
      "broker-quotes",
      releaseBlock,
      generatedAt,
      ["billBroker", "spot", "usdc"],
      [
        "Every quote is an eth_call result of the deployed Bill Broker at the release block; no quote is computed by this project.",
        "Swap grids pass the recorded reserve state to computeUSDToPerpSwapAmt and computePerpToUSDSwapAmt.",
        "LP rows record computeRedemptionAmts and, for redeemed SPOT, computePerpToUSDSwapAmt against the reserves left after the withdrawal.",
      ],
    ),
    brokerAddress: broker.brokerAddress,
    implementationAddress: broker.implementationAddress,
    implementationCodeHash: broker.implementationCodeHash,
    usdToken: broker.usdToken,
    spotToken: broker.spotToken,
    reserveState: broker.reserveState,
    lpSupply: lpSupply.toString(),
    lpDecimals: lpDecimals.toString(),
    burnFeePercent: broker.parameters.fees.burnFeePercent,
    grid: {
      definition,
      spotToUsd,
      usdToSpot,
    },
    lpRedemptions,
  });
}

export async function readAmplRebasesDataset(
  client: ObservatoryPublicClient,
  releaseBlock: ResolvedReleaseBlock,
  generatedAt: string,
  targetRateResolver: AmplTargetRateResolver,
  ranges: {
    readonly initial?: bigint;
    readonly maximum?: bigint;
    readonly responseLimit?: number;
  } = {},
  logClient: ObservatoryLogClient = client,
): Promise<AmplRebasesDataset> {
  const rangeOptions = {
    ...(ranges.initial === undefined
      ? {}
      : { initialRange: ranges.initial }),
    ...(ranges.maximum === undefined
      ? {}
      : { maximumRange: ranges.maximum }),
    ...(ranges.responseLimit === undefined
      ? {}
      : { maximumLogsPerResponse: ranges.responseLimit }),
  };
  const [rawLegacyPolicyLogs, rawV2PolicyLogs, rawTokenLogs] =
    await Promise.all([
      fetchLogsAdaptive({
        client: logClient,
        address: CONTRACTS.amplPolicy.address,
        event: AMPL_POLICY_REBASE_EVENT,
        fromBlock: CONTRACTS.amplPolicy.deploymentBlock,
        toBlock: releaseBlock.number,
        ...rangeOptions,
      }),
      fetchLogsAdaptive({
        client: logClient,
        address: CONTRACTS.amplPolicy.address,
        event: AMPL_POLICY_REBASE_V2_EVENT,
        fromBlock: CONTRACTS.amplPolicy.deploymentBlock,
        toBlock: releaseBlock.number,
        ...rangeOptions,
      }),
      fetchLogsAdaptive({
        client: logClient,
        address: CONTRACTS.amplToken.address,
        event: AMPL_TOKEN_REBASE_EVENT,
        fromBlock: CONTRACTS.amplToken.deploymentBlock,
        toBlock: releaseBlock.number,
        ...rangeOptions,
      }),
    ]);
  const timestampPromises = new Map<string, Promise<bigint>>();
  const v2PolicyLogs = await Promise.all(
    rawV2PolicyLogs.map(async (rawLog) => {
      const log = asRecord(rawLog, "AMPL V2 policy log");
      const blockNumber = asBigInt(
        logField(log, "blockNumber"),
        "AMPL V2 policy block number",
      );
      const blockHash = asHash(
        logField(log, "blockHash"),
        "AMPL V2 policy block",
      );
      const key = blockNumber.toString();
      let timestamp = timestampPromises.get(key);
      if (timestamp === undefined) {
        timestamp = client
          .getBlock({ blockNumber })
          .then((block) => {
            if (
              block.hash === null ||
              block.hash.toLowerCase() !== blockHash.toLowerCase()
            ) {
              throw new Error(
                "AMPL V2 event block hash changed during refresh",
              );
            }
            return block.timestamp;
          });
        timestampPromises.set(key, timestamp);
      }
      return normalizeAmplPolicyV2Log(rawLog, await timestamp);
    }),
  );
  const rows = await pairAmplRebaseLogs(
    [
      ...rawLegacyPolicyLogs.map(normalizeAmplPolicyLog),
      ...v2PolicyLogs,
    ],
    rawTokenLogs.map(normalizeAmplTokenLog),
    targetRateResolver,
  );
  return amplRebasesDatasetSchema.parse({
    metadata: metadataFor(
      "ampl-rebases",
      releaseBlock,
      generatedAt,
      ["amplToken", "amplPolicy"],
      [
        "Legacy LogRebase and V2 LogRebaseV2 policy events are paired with token events by epoch, block, and transaction.",
        "Legacy targets use the CPI value emitted by LogRebase; V2 targets are emitted by LogRebaseV2.",
      ],
    ),
    rateDecimals: "18",
    supplyDecimals: "9",
    rows,
  });
}

function createMetaDataset(
  releaseBlock: ResolvedReleaseBlock,
  generatedAt: string,
): MetaDataset {
  return metaDatasetSchema.parse({
    metadata: metadataFor(
      "meta",
      releaseBlock,
      generatedAt,
      [
        "amplToken",
        "amplPolicy",
        "spot",
        "rolloverVault",
        "spotFeePolicy",
        "billBroker",
        "usdc",
      ],
      [
        "Generated files are deterministic plaintext JSON and CSV.",
        "broker-quotes.json records eth_call quote grids of the deployed Bill Broker at the release block.",
      ],
    ),
    files: [
      {
        dataset: "meta",
        path: "/data/meta.json",
        format: "json",
        status: "release",
        schemaVersion: DATA_SCHEMA_VERSION,
      },
      {
        dataset: "ampl-rebases",
        path: "/data/ampl-rebases.json",
        format: "json",
        status: "release",
        schemaVersion: DATA_SCHEMA_VERSION,
      },
      {
        dataset: "ampl-rebases",
        path: "/data/ampl-rebases.csv",
        format: "csv",
        status: "release",
        schemaVersion: DATA_SCHEMA_VERSION,
      },
      {
        dataset: "spot-health",
        path: "/data/spot-health.json",
        format: "json",
        status: "release",
        schemaVersion: DATA_SCHEMA_VERSION,
      },
      {
        dataset: "spot-health",
        path: "/data/spot-health.csv",
        format: "csv",
        status: "release",
        schemaVersion: DATA_SCHEMA_VERSION,
      },
      {
        dataset: "broker-state",
        path: "/data/broker-state.json",
        format: "json",
        status: "release",
        schemaVersion: DATA_SCHEMA_VERSION,
      },
      {
        dataset: "broker-state",
        path: "/data/broker-state.csv",
        format: "csv",
        status: "release",
        schemaVersion: DATA_SCHEMA_VERSION,
      },
      {
        dataset: "broker-quotes",
        path: "/data/broker-quotes.json",
        format: "json",
        status: "release",
        schemaVersion: DATA_SCHEMA_VERSION,
      },
      {
        dataset: "broker-quotes",
        path: "/data/broker-quotes.csv",
        format: "csv",
        status: "release",
        schemaVersion: DATA_SCHEMA_VERSION,
      },
    ],
  });
}

const AMPL_CSV_COLUMNS: readonly CsvColumn<AmplRebaseRow>[] = [
  { header: "chain_id", value: () => "1" },
  { header: "epoch", value: (row) => row.epoch },
  { header: "timestamp", value: (row) => row.timestamp },
  { header: "block_number", value: (row) => row.blockNumber },
  { header: "block_hash", value: (row) => row.blockHash },
  { header: "transaction_hash", value: (row) => row.transactionHash },
  { header: "policy_log_index", value: (row) => row.logIndex },
  { header: "token_log_index", value: (row) => row.tokenLogIndex },
  { header: "policy_schema", value: (row) => row.policySchema },
  { header: "exchange_rate", value: (row) => row.exchangeRate },
  { header: "cpi_oracle_value", value: (row) => row.cpiOracleValue },
  {
    header: "cpi_adjusted_target_rate",
    value: (row) => row.cpiAdjustedTargetRate,
  },
  {
    header: "requested_supply_adjustment",
    value: (row) => row.requestedSupplyAdjustment,
  },
  { header: "total_supply", value: (row) => row.totalSupply },
  {
    header: "previous_total_supply",
    value: (row) => row.previousTotalSupply,
  },
  {
    header: "supply_change_percent",
    value: (row) => row.supplyChangePercent,
  },
];

interface SpotCsvRow {
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly blockTimestamp: string | null;
  readonly implementationAddress: string;
  readonly implementationCodeHash: string;
  readonly deviationRatio: string;
  readonly rolloverVaultTvl: string;
  readonly spotCollateralTvl: string;
  readonly spotTotalSupply: string;
  readonly collateralCoverage: string | null;
  readonly tokenAddress: string;
  readonly tokenName: string | null;
  readonly tokenSymbol: string | null;
  readonly tokenDecimals: string;
  readonly balance: string;
  readonly underlyingValue: string;
  readonly isUnderlying: boolean;
  readonly bondAddress: string | null;
  readonly maturityTimestamp: string | null;
  readonly maturity: string | null;
}

function spotCsvRows(dataset: SpotHealthDataset): SpotCsvRow[] {
  return dataset.reserves.map((reserve) => ({
    chainId: dataset.metadata.chainId.toString(),
    blockNumber: dataset.metadata.blockNumber,
    blockHash: dataset.metadata.blockHash,
    blockTimestamp: dataset.metadata.blockTimestamp,
    implementationAddress: dataset.spot.implementationAddress,
    implementationCodeHash: dataset.spot.implementationCodeHash,
    deviationRatio: dataset.rolloverVault.deviationRatio,
    rolloverVaultTvl: dataset.rolloverVault.tvl,
    spotCollateralTvl: dataset.spot.collateralTvl,
    spotTotalSupply: dataset.spot.totalSupply,
    collateralCoverage: dataset.spot.collateralCoverage,
    tokenAddress: reserve.token.address,
    tokenName: reserve.token.name,
    tokenSymbol: reserve.token.symbol,
    tokenDecimals: reserve.token.decimals,
    balance: reserve.balance,
    underlyingValue: reserve.underlyingValue,
    isUnderlying: reserve.isUnderlying,
    bondAddress: reserve.bondAddress,
    maturityTimestamp: reserve.maturityTimestamp,
    maturity: reserve.maturity,
  }));
}

const SPOT_CSV_COLUMNS: readonly CsvColumn<SpotCsvRow>[] = [
  { header: "chain_id", value: (row) => row.chainId },
  { header: "block_number", value: (row) => row.blockNumber },
  { header: "block_hash", value: (row) => row.blockHash },
  { header: "block_timestamp", value: (row) => row.blockTimestamp },
  {
    header: "implementation_address",
    value: (row) => row.implementationAddress,
  },
  {
    header: "implementation_code_hash",
    value: (row) => row.implementationCodeHash,
  },
  { header: "deviation_ratio", value: (row) => row.deviationRatio },
  {
    header: "rollover_vault_tvl",
    value: (row) => row.rolloverVaultTvl,
  },
  { header: "spot_collateral_tvl", value: (row) => row.spotCollateralTvl },
  { header: "spot_total_supply", value: (row) => row.spotTotalSupply },
  {
    header: "collateral_coverage",
    value: (row) => row.collateralCoverage,
  },
  { header: "token_address", value: (row) => row.tokenAddress },
  { header: "token_name", value: (row) => row.tokenName },
  { header: "token_symbol", value: (row) => row.tokenSymbol },
  { header: "token_decimals", value: (row) => row.tokenDecimals },
  { header: "balance", value: (row) => row.balance },
  { header: "underlying_value", value: (row) => row.underlyingValue },
  { header: "is_underlying", value: (row) => row.isUnderlying },
  { header: "bond_address", value: (row) => row.bondAddress },
  {
    header: "maturity_timestamp",
    value: (row) => row.maturityTimestamp,
  },
  { header: "maturity", value: (row) => row.maturity },
];

interface BrokerCsvRow {
  readonly [key: string]: boolean | null | string;
}

function brokerCsvRow(dataset: BrokerStateDataset): BrokerCsvRow {
  return {
    chain_id: dataset.metadata.chainId.toString(),
    block_number: dataset.metadata.blockNumber,
    block_hash: dataset.metadata.blockHash,
    broker_address: dataset.brokerAddress,
    implementation_address: dataset.implementationAddress,
    implementation_code_hash: dataset.implementationCodeHash,
    usd_address: dataset.usdToken.address,
    spot_address: dataset.spotToken.address,
    usd_balance: dataset.reserveState.usdBalance,
    spot_balance: dataset.reserveState.spotBalance,
    usd_price: dataset.reserveState.usdPrice,
    spot_price: dataset.reserveState.spotPrice,
    asset_ratio: dataset.assetRatio,
    soft_bound_lower: dataset.parameters.softAssetRatioBounds.lower,
    soft_bound_upper: dataset.parameters.softAssetRatioBounds.upper,
    hard_bound_lower: dataset.parameters.hardAssetRatioBounds.lower,
    hard_bound_upper: dataset.parameters.hardAssetRatioBounds.upper,
    one: dataset.parameters.one,
    mint_fee_percent: dataset.parameters.fees.mintFeePercent,
    burn_fee_percent: dataset.parameters.fees.burnFeePercent,
    spot_to_usd_fee_factor_lower:
      dataset.parameters.fees.spotToUsdFeeFactors.lower,
    spot_to_usd_fee_factor_upper:
      dataset.parameters.fees.spotToUsdFeeFactors.upper,
    usd_to_spot_fee_factor_lower:
      dataset.parameters.fees.usdToSpotFeeFactors.lower,
    usd_to_spot_fee_factor_upper:
      dataset.parameters.fees.usdToSpotFeeFactors.upper,
    protocol_swap_share_percent:
      dataset.parameters.fees.protocolSwapSharePercent,
    usd_to_spot_input: dataset.quotes.usdToSpot.inputAmount,
    usd_to_spot_available: dataset.quotes.usdToSpot.available,
    usd_to_spot_output: dataset.quotes.usdToSpot.outputAmount,
    usd_to_spot_protocol_fee:
      dataset.quotes.usdToSpot.protocolFeeAmount,
    usd_to_spot_unavailable_reason:
      dataset.quotes.usdToSpot.unavailableReason,
    spot_to_usd_input: dataset.quotes.spotToUsd.inputAmount,
    spot_to_usd_available: dataset.quotes.spotToUsd.available,
    spot_to_usd_output: dataset.quotes.spotToUsd.outputAmount,
    spot_to_usd_protocol_fee:
      dataset.quotes.spotToUsd.protocolFeeAmount,
    spot_to_usd_unavailable_reason:
      dataset.quotes.spotToUsd.unavailableReason,
  };
}

function brokerCsvColumns(
  row: BrokerCsvRow,
): readonly CsvColumn<BrokerCsvRow>[] {
  return Object.keys(row)
    .sort()
    .map((header) => ({
      header,
      value: (value: BrokerCsvRow) => value[header] ?? null,
    }));
}

interface BrokerQuotesCsvRow {
  readonly [key: string]: boolean | null | string;
}

/** One flat row per recorded swap quote and per recorded LP redemption. */
function brokerQuotesCsvRows(
  dataset: BrokerQuotesDataset,
): readonly BrokerQuotesCsvRow[] {
  const context = {
    chain_id: dataset.metadata.chainId.toString(),
    block_number: dataset.metadata.blockNumber,
    block_hash: dataset.metadata.blockHash,
    broker_address: dataset.brokerAddress,
    implementation_address: dataset.implementationAddress,
    implementation_code_hash: dataset.implementationCodeHash,
    usd_balance: dataset.reserveState.usdBalance,
    spot_balance: dataset.reserveState.spotBalance,
    usd_price: dataset.reserveState.usdPrice,
    spot_price: dataset.reserveState.spotPrice,
  };
  const empty = {
    lp_amount: null,
    usd_out: null,
    spot_out: null,
    post_usd_balance: null,
    post_spot_balance: null,
    sale_available: null,
    sale_output_amount: null,
    sale_protocol_fee_amount: null,
    sale_unavailable_reason: null,
  };
  const swapRows = (
    [
      ["spot-to-usd", dataset.grid.spotToUsd],
      ["usd-to-spot", dataset.grid.usdToSpot],
    ] as const
  ).flatMap(([direction, quotes]) =>
    quotes.map(
      (quote): BrokerQuotesCsvRow => ({
        ...context,
        kind: "swap-quote",
        direction,
        input_asset: quote.inputAsset,
        output_asset: quote.outputAsset,
        input_amount: quote.inputAmount,
        available: quote.available,
        output_amount: quote.outputAmount,
        protocol_fee_amount: quote.protocolFeeAmount,
        unavailable_reason: quote.unavailableReason,
        ...empty,
      }),
    ),
  );
  const lpRows = dataset.lpRedemptions.map(
    (redemption): BrokerQuotesCsvRow => ({
      ...context,
      kind: "lp-redemption",
      direction: "lp-to-usd-and-spot",
      input_asset: dataset.brokerAddress,
      output_asset: null,
      input_amount: redemption.lpAmount,
      available: redemption.available,
      output_amount: null,
      protocol_fee_amount: null,
      unavailable_reason: redemption.unavailableReason,
      lp_amount: redemption.lpAmount,
      usd_out: redemption.usdOut,
      spot_out: redemption.spotOut,
      post_usd_balance: redemption.postWithdrawalReserves?.usdBalance ?? null,
      post_spot_balance:
        redemption.postWithdrawalReserves?.spotBalance ?? null,
      sale_available: redemption.sale?.available ?? null,
      sale_output_amount: redemption.sale?.outputAmount ?? null,
      sale_protocol_fee_amount: redemption.sale?.protocolFeeAmount ?? null,
      sale_unavailable_reason: redemption.sale?.unavailableReason ?? null,
    }),
  );
  return [...swapRows, ...lpRows];
}

function brokerQuotesCsvColumns(
  rows: readonly BrokerQuotesCsvRow[],
): readonly CsvColumn<BrokerQuotesCsvRow>[] {
  const headers = new Set<string>();
  for (const row of rows) {
    for (const header of Object.keys(row)) {
      headers.add(header);
    }
  }
  return [...headers].sort().map((header) => ({
    header,
    value: (value: BrokerQuotesCsvRow) => value[header] ?? null,
  }));
}

export async function writeRefreshDatasets(
  outputDirectory: string,
  datasets: {
    readonly ampl: AmplRebasesDataset;
    readonly spot: SpotHealthDataset;
    readonly broker: BrokerStateDataset;
    readonly brokerQuotes: BrokerQuotesDataset;
    readonly meta: MetaDataset;
  },
): Promise<readonly string[]> {
  const ampl = amplRebasesDatasetSchema.parse(datasets.ampl);
  const spot = spotHealthDatasetSchema.parse(datasets.spot);
  const broker = brokerStateDatasetSchema.parse(datasets.broker);
  const brokerQuotes = brokerQuotesDatasetSchema.parse(datasets.brokerQuotes);
  const meta = metaDatasetSchema.parse(datasets.meta);
  const brokerRow = brokerCsvRow(broker);
  const brokerQuoteRows = brokerQuotesCsvRows(brokerQuotes);

  const namedContents = [
    {
      name: "ampl-rebases.json",
      contents: stableJsonStringify(ampl),
    },
    {
      name: "ampl-rebases.csv",
      contents: stableCsvStringify(ampl.rows, AMPL_CSV_COLUMNS),
    },
    {
      name: "spot-health.json",
      contents: stableJsonStringify(spot),
    },
    {
      name: "spot-health.csv",
      contents: stableCsvStringify(
        spotCsvRows(spot),
        SPOT_CSV_COLUMNS,
      ),
    },
    {
      name: "broker-state.json",
      contents: stableJsonStringify(broker),
    },
    {
      name: "broker-state.csv",
      contents: stableCsvStringify(
        [brokerRow],
        brokerCsvColumns(brokerRow),
      ),
    },
    {
      name: "broker-quotes.json",
      contents: stableJsonStringify(brokerQuotes),
    },
    {
      name: "broker-quotes.csv",
      contents: stableCsvStringify(
        brokerQuoteRows,
        brokerQuotesCsvColumns(brokerQuoteRows),
      ),
    },
    {
      name: "meta.json",
      contents: stableJsonStringify(meta),
    },
  ] as const;

  await atomicWriteTextFiles(
    namedContents.map((file) => ({
      path: join(outputDirectory, file.name),
      contents: file.contents,
    })),
  );
  return namedContents.map((file) => file.name);
}

export async function runRefresh(
  options: RefreshOptions,
): Promise<RefreshResult> {
  const chainId = await options.client.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`Expected Ethereum mainnet chain ID 1, received ${chainId}`);
  }
  const releaseBlock = await resolveReleaseBlock(
    options.client,
    options.releaseBlock,
  );
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();

  const [ampl, spot, broker] = await Promise.all([
    readAmplRebasesDataset(
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
    ),
    readSpotHealthDataset(
      options.client,
      releaseBlock,
      generatedAt,
      options.implementationVerifier,
    ),
    readBrokerStateDataset(
      options.client,
      releaseBlock,
      generatedAt,
      options.implementationVerifier,
    ),
  ]);

  const brokerQuotes = await readBrokerQuotesDataset(
    options.client,
    releaseBlock,
    generatedAt,
    broker,
    options.brokerQuoteGrid ?? DEFAULT_BROKER_QUOTE_GRID,
  );

  await verifyReleaseBlockCanonical(options.client, releaseBlock);
  const meta = createMetaDataset(releaseBlock, generatedAt);
  const files = await writeRefreshDatasets(options.outputDirectory, {
    ampl,
    spot,
    broker,
    brokerQuotes,
    meta,
  });
  return { releaseBlock, files };
}
