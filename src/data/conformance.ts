import {
  AMPL_POLICY_REBASE_EVENT,
  AMPL_POLICY_REBASE_V2_EVENT,
  AMPL_TOKEN_REBASE_EVENT,
  ARCHIVE_CALL_ABI,
  CONTRACTS,
  MAINNET_CHAIN_ID,
} from "./contracts";
import {
  DATA_SCHEMA_VERSION,
  conformanceReportSchema,
  type ConformanceReport,
} from "./schemas";
import {
  fetchLogsAdaptive,
  normalizeAmplPolicyLog,
  normalizeAmplPolicyV2Log,
  normalizeAmplTokenLog,
  resolveReleaseBlock,
  type ObservatoryPublicClient,
  type ReleaseBlockRequest,
  type ResolvedReleaseBlock,
} from "./refresh";

interface MutableCheck {
  readonly id: string;
  readonly status: "fail" | "pass";
  readonly message: string;
}

export interface ConformanceOptions {
  readonly client: ObservatoryPublicClient;
  readonly releaseBlock: ReleaseBlockRequest;
  readonly now?: () => Date;
  readonly logWindow?: bigint;
}

interface RequiredLogPair {
  readonly policyEpoch: bigint;
  readonly tokenEpoch: bigint;
  readonly policyTransactionHash: string;
  readonly tokenTransactionHash: string;
}

function passed(id: string, message: string): MutableCheck {
  return { id, status: "pass", message };
}

function failed(id: string, message: string): MutableCheck {
  return { id, status: "fail", message };
}

async function findRecentLogs(
  client: ObservatoryPublicClient,
  request: {
    readonly address: `0x${string}`;
    readonly event: unknown;
    readonly deploymentBlock: bigint;
    readonly releaseBlock: bigint;
    readonly initialWindow: bigint;
  },
): Promise<readonly unknown[]> {
  if (request.releaseBlock < request.deploymentBlock) {
    return [];
  }
  let end = request.releaseBlock;
  let window = request.initialWindow > 0n ? request.initialWindow : 50_000n;
  while (end >= request.deploymentBlock) {
    const possibleStart = end - window + 1n;
    const start =
      possibleStart < request.deploymentBlock
        ? request.deploymentBlock
        : possibleStart;
    const logs = await fetchLogsAdaptive({
      client,
      address: request.address,
      event: request.event,
      fromBlock: start,
      toBlock: end,
      initialRange: window,
      maximumRange: window,
    });
    if (logs.length > 0) {
      return logs;
    }
    if (start === request.deploymentBlock) {
      return [];
    }
    end = start - 1n;
    window *= 2n;
  }
  return [];
}

async function readRequiredLogPair(
  client: ObservatoryPublicClient,
  releaseBlock: bigint,
  window: bigint,
): Promise<RequiredLogPair> {
  const [v2PolicyRaw, tokenRaw] = await Promise.all([
    findRecentLogs(client, {
      address: CONTRACTS.amplPolicy.address,
      event: AMPL_POLICY_REBASE_V2_EVENT,
      deploymentBlock: CONTRACTS.amplPolicy.deploymentBlock,
      releaseBlock,
      initialWindow: window,
    }),
    findRecentLogs(client, {
      address: CONTRACTS.amplToken.address,
      event: AMPL_TOKEN_REBASE_EVENT,
      deploymentBlock: CONTRACTS.amplToken.deploymentBlock,
      releaseBlock,
      initialWindow: window,
    }),
  ]);
  const legacyPolicyRaw =
    v2PolicyRaw.length === 0
      ? await findRecentLogs(client, {
          address: CONTRACTS.amplPolicy.address,
          event: AMPL_POLICY_REBASE_EVENT,
          deploymentBlock: CONTRACTS.amplPolicy.deploymentBlock,
          releaseBlock,
          initialWindow: window,
        })
      : [];
  if (
    legacyPolicyRaw.length === 0 &&
    v2PolicyRaw.length === 0
  ) {
    throw new Error("Required AMPL policy rebase logs were not found");
  }
  if (tokenRaw.length === 0) {
    throw new Error("Required AMPL rebase logs were not found");
  }

  const policy = [
    ...legacyPolicyRaw.map(normalizeAmplPolicyLog),
    ...v2PolicyRaw.map((log) => normalizeAmplPolicyV2Log(log, 0n)),
  ];
  const token = tokenRaw.map(normalizeAmplTokenLog);
  const tokenByEpoch = new Map(
    token.map((entry) => [entry.epoch.toString(), entry]),
  );
  const matchingPolicy = [...policy]
    .sort((left, right) =>
      left.epoch < right.epoch ? 1 : left.epoch > right.epoch ? -1 : 0,
    )
    .find((entry) => tokenByEpoch.has(entry.epoch.toString()));
  if (matchingPolicy === undefined) {
    throw new Error("AMPL policy and token logs have no matching epoch");
  }
  const matchingToken = tokenByEpoch.get(matchingPolicy.epoch.toString());
  if (
    matchingToken === undefined ||
    matchingToken.transactionHash.toLowerCase() !==
      matchingPolicy.transactionHash.toLowerCase()
  ) {
    throw new Error("AMPL policy and token logs do not pair by transaction");
  }
  return {
    policyEpoch: matchingPolicy.epoch,
    tokenEpoch: matchingToken.epoch,
    policyTransactionHash: matchingPolicy.transactionHash,
    tokenTransactionHash: matchingToken.transactionHash,
  };
}

async function checkPrimaryBytecode(
  client: ObservatoryPublicClient,
  blockNumber: bigint,
): Promise<void> {
  const contracts = Object.values(CONTRACTS);
  const bytecodes = await Promise.all(
    contracts.map((contract) =>
      client.getCode({
        address: contract.address,
        blockNumber,
      }),
    ),
  );
  const missingIndex = bytecodes.findIndex(
    (bytecode) => bytecode === undefined || bytecode === "0x",
  );
  if (missingIndex >= 0) {
    const contract = contracts[missingIndex];
    throw new Error(
      `Primary contract bytecode is unavailable for ${contract?.role ?? "unknown"}`,
    );
  }
}

async function checkArchiveCall(
  client: ObservatoryPublicClient,
  blockNumber: bigint,
): Promise<void> {
  const value = await client.readContract({
    address: CONTRACTS.amplToken.address,
    abi: ARCHIVE_CALL_ABI,
    functionName: "totalSupply",
    blockNumber,
  });
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error("Archive eth_call returned an invalid total supply");
  }
}

export async function runConformance(
  options: ConformanceOptions,
): Promise<ConformanceReport> {
  const checks: MutableCheck[] = [];
  let observedChainId: number | null = null;
  let resolvedBlock: ResolvedReleaseBlock | null = null;

  try {
    observedChainId = await options.client.getChainId();
    checks.push(
      observedChainId === MAINNET_CHAIN_ID
        ? passed("rpc-chain-id", "RPC reports Ethereum mainnet chain ID 1.")
        : failed(
            "rpc-chain-id",
            `RPC reports chain ID ${observedChainId}; expected 1.`,
          ),
    );
  } catch {
    checks.push(failed("rpc-chain-id", "RPC chain ID request failed."));
  }

  try {
    resolvedBlock = await resolveReleaseBlock(
      options.client,
      options.releaseBlock,
    );
    checks.push(
      passed(
        "release-block",
        "Release block number and hash resolved and verified.",
      ),
    );
  } catch {
    checks.push(
      failed(
        "release-block",
        "Release block number and hash could not be verified.",
      ),
    );
  }

  if (resolvedBlock === null) {
    checks.push(
      failed(
        "archive-eth-call",
        "Archive eth_call was not attempted because the release block failed.",
      ),
      failed(
        "required-ampl-logs",
        "AMPL logs were not checked because the release block failed.",
      ),
      failed(
        "primary-bytecode",
        "Contract bytecode was not checked because the release block failed.",
      ),
    );
  } else {
    try {
      await checkArchiveCall(options.client, resolvedBlock.number);
      checks.push(
        passed(
          "archive-eth-call",
          "Historical eth_call succeeded at the release block.",
        ),
      );
    } catch {
      checks.push(
        failed(
          "archive-eth-call",
          "Historical eth_call failed at the release block.",
        ),
      );
    }

    try {
      const pair = await readRequiredLogPair(
        options.client,
        resolvedBlock.number,
        options.logWindow ?? 50_000n,
      );
      if (
        pair.policyEpoch !== pair.tokenEpoch ||
        pair.policyTransactionHash.toLowerCase() !==
          pair.tokenTransactionHash.toLowerCase()
      ) {
        throw new Error("Unpaired AMPL logs");
      }
      checks.push(
        passed(
          "required-ampl-logs",
          "Matching AMPL policy and token rebase logs are available.",
        ),
      );
    } catch {
      checks.push(
        failed(
          "required-ampl-logs",
          "Matching AMPL policy and token rebase logs are unavailable.",
        ),
      );
    }

    try {
      await checkPrimaryBytecode(options.client, resolvedBlock.number);
      checks.push(
        passed(
          "primary-bytecode",
          "Primary contract bytecode is available at the release block.",
        ),
      );
    } catch {
      checks.push(
        failed(
          "primary-bytecode",
          "One or more primary contracts have no bytecode at the release block.",
        ),
      );
    }
  }

  return conformanceReportSchema.parse({
    schemaVersion: DATA_SCHEMA_VERSION,
    report: "ethereum-rpc-conformance",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    chainId: MAINNET_CHAIN_ID,
    observedChainId:
      observedChainId === null ? null : observedChainId.toString(),
    blockNumber: options.releaseBlock.number.toString(),
    blockHash:
      resolvedBlock?.hash ?? options.releaseBlock.expectedHash ?? null,
    passed: checks.every((check) => check.status === "pass"),
    checks,
  });
}
