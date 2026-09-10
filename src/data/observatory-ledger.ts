import { parseAbiItem } from "viem";

import { CONTRACTS } from "./contracts";
import {
  brokerLedgerSchema,
  type BrokerHistoryEvent,
  type BrokerLedger,
} from "./observatory-schemas";
import { fetchLogsAdaptive, type ObservatoryLogClient } from "./refresh";
import { evmAddressSchema, evmHashSchema } from "./schemas";

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);
const UPGRADED = parseAbiItem("event Upgraded(address indexed implementation)");
const BROKER = CONTRACTS.billBroker.address.toLowerCase();

export interface BrokerAssetTransfer {
  blockNumber: bigint;
  transactionHash: string;
  logIndex: bigint;
  asset: "usdc" | "spot";
  from: string;
  to: string;
  amount: bigint;
}

function rpcRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object")
    throw new Error("Invalid transfer log");
  return value as Record<string, unknown>;
}
function logInteger(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  throw new Error("Invalid transfer integer");
}

/** Reconcile token movements; infer a fee only for an unambiguous single swap. */
export function buildBrokerLedger(
  fromBlock: bigint,
  toBlock: bigint,
  operations: readonly BrokerHistoryEvent[],
  transfers: readonly BrokerAssetTransfer[],
): BrokerLedger {
  const groups = new Map<
    string,
    { transfers: BrokerAssetTransfer[]; operations: BrokerHistoryEvent[] }
  >();
  const group = (hash: string) => {
    const key = hash.toLowerCase();
    if (!groups.has(key)) groups.set(key, { transfers: [], operations: [] });
    return groups.get(key)!;
  };
  const seenTransfer = new Set<string>();
  for (const transfer of transfers) {
    if (transfer.blockNumber <= fromBlock || transfer.blockNumber > toBlock)
      throw new Error("Transfer falls outside ledger interval");
    const id = `${transfer.transactionHash.toLowerCase()}:${transfer.logIndex}`;
    if (seenTransfer.has(id)) continue;
    seenTransfer.add(id);
    group(transfer.transactionHash).transfers.push(transfer);
  }
  for (const op of operations) {
    if (BigInt(op.blockNumber) <= fromBlock || BigInt(op.blockNumber) > toBlock)
      continue;
    group(op.transactionHash).operations.push(op);
  }
  const events: BrokerLedger["events"] = [];
  for (const [transactionHash, grouped] of groups) {
    const tokenTransfers = grouped.transfers.sort((a, b) =>
      a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : 0,
    );
    const ops = grouped.operations;
    let usdcDelta = 0n;
    let spotDelta = 0n;
    let lpSupplyDelta = 0n;
    for (const transfer of tokenTransfers) {
      const delta =
        (transfer.to.toLowerCase() === BROKER ? transfer.amount : 0n) -
        (transfer.from.toLowerCase() === BROKER ? transfer.amount : 0n);
      if (transfer.asset === "usdc") usdcDelta += delta;
      else spotDelta += delta;
    }
    for (const op of ops) {
      if (op.event === "LpMint") lpSupplyDelta += BigInt(op.amount);
      if (op.event === "LpBurn") lpSupplyDelta -= BigInt(op.amount);
    }
    const swaps = ops.filter(
      (op) => op.event === "SwapPerpsForUSD" || op.event === "SwapUSDForPerps",
    );
    const kind: BrokerLedger["events"][number]["kind"] =
      swaps.length > 0
        ? "swap"
        : lpSupplyDelta > 0n
          ? "deposit"
          : lpSupplyDelta < 0n
            ? "withdrawal"
            : ops.length === 0
              ? "transfer"
              : "other";
    let fee: BrokerLedger["events"][number]["fee"] = null;
    const swap = swaps[0];
    if (
      kind === "swap" &&
      swaps.length === 1 &&
      ops.length === 1 &&
      swap !== undefined &&
      swap.preState !== null
    ) {
      const inputAsset = swap.event === "SwapPerpsForUSD" ? "spot" : "usdc";
      const outputAsset = inputAsset === "spot" ? "usdc" : "spot";
      const inputs = tokenTransfers.filter(
        (transfer) =>
          transfer.to.toLowerCase() === BROKER &&
          transfer.from.toLowerCase() !== BROKER,
      );
      const outputs = tokenTransfers.filter(
        (transfer) =>
          transfer.from.toLowerCase() === BROKER &&
          transfer.to.toLowerCase() !== BROKER,
      );
      const input = inputs[0];
      const userOutput = outputs.at(-1);
      const protocol = outputs.length === 2 ? outputs[0]!.amount : 0n;
      const hasExpectedTransfers =
        tokenTransfers.length === inputs.length + outputs.length &&
        inputs.length === 1 &&
        outputs.length >= 1 &&
        outputs.length <= 2 &&
        input?.asset === inputAsset &&
        input.amount === BigInt(swap.amount) &&
        outputs.every((transfer) => transfer.asset === outputAsset) &&
        userOutput !== undefined &&
        input.logIndex < outputs[0]!.logIndex &&
        userOutput.logIndex < BigInt(swap.logIndex) &&
        userOutput.to.toLowerCase() === input.from.toLowerCase();
      if (hasExpectedTransfers && userOutput !== undefined) {
        const priceIn = BigInt(
          inputAsset === "spot"
            ? swap.preState.spotPrice
            : swap.preState.usdPrice,
        );
        const priceOut = BigInt(
          inputAsset === "spot"
            ? swap.preState.usdPrice
            : swap.preState.spotPrice,
        );
        const unitIn = inputAsset === "spot" ? 10n ** 9n : 10n ** 6n;
        const unitOut = outputAsset === "spot" ? 10n ** 9n : 10n ** 6n;
        if (priceOut > 0n) {
          const gross =
            (((BigInt(swap.amount) * priceIn) / priceOut) * unitOut) / unitIn;
          const charged = gross - userOutput.amount;
          if (
            (charged < 0n && protocol === 0n) ||
            (charged >= 0n && protocol <= charged)
          ) {
            fee = {
              asset: outputAsset,
              amount: charged.toString(),
              protocolAmount: protocol.toString(),
              evidence: "transaction-verified",
            };
          }
        }
      }
    }
    const firstTransfer = tokenTransfers[0];
    const firstOp = ops[0];
    const blockNumber =
      firstTransfer?.blockNumber ?? BigInt(firstOp!.blockNumber);
    if (
      tokenTransfers.some((transfer) => transfer.blockNumber !== blockNumber) ||
      ops.some((op) => BigInt(op.blockNumber) !== blockNumber)
    )
      throw new Error("Transaction ledger spans inconsistent blocks");
    const indexes = [
      ...tokenTransfers.map((transfer) => transfer.logIndex),
      ...ops.map((op) => BigInt(op.logIndex)),
    ];
    const logIndex = indexes.reduce((minimum, index) =>
      index < minimum ? index : minimum,
    );
    events.push({
      blockNumber: blockNumber.toString(),
      logIndex: logIndex.toString(),
      transactionHash,
      kind,
      usdcDelta: usdcDelta.toString(),
      spotDelta: spotDelta.toString(),
      lpSupplyDelta: lpSupplyDelta.toString(),
      fee,
    });
  }
  events.sort((a, b) =>
    BigInt(a.blockNumber) < BigInt(b.blockNumber)
      ? -1
      : BigInt(a.blockNumber) > BigInt(b.blockNumber)
        ? 1
        : Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
  );
  return brokerLedgerSchema.parse({
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    coverage: "complete",
    events,
  });
}

export async function readBrokerLedger(options: {
  client: ObservatoryLogClient;
  fromBlock: bigint;
  toBlock: bigint;
  operations: readonly BrokerHistoryEvent[];
  verifyBlock: (blockNumber: bigint) => Promise<unknown>;
  verifyCanonicalBlock?: (
    blockNumber: bigint,
    expectedHash: `0x${string}`,
  ) => Promise<unknown>;
  maximumLogRange?: bigint;
  maximumLogsPerResponse?: number;
}): Promise<BrokerLedger> {
  const transfers: BrokerAssetTransfer[] = [];
  const observedHashes = new Map<bigint, `0x${string}`>();
  for (const [asset, token] of [
    ["usdc", CONTRACTS.usdc.address],
    ["spot", CONTRACTS.spot.address],
  ] as const) {
    for (const direction of ["from", "to"] as const) {
      const filteredClient: ObservatoryLogClient = {
        getLogs: (request) =>
          (
            options.client.getLogs as (
              request: Readonly<Record<string, unknown>>,
            ) => Promise<readonly unknown[]>
          ).call(options.client, {
            ...request,
            args: { [direction]: CONTRACTS.billBroker.address },
          }),
      };
      const logs = await fetchLogsAdaptive({
        client: filteredClient,
        address: token,
        event: TRANSFER,
        fromBlock: options.fromBlock + 1n,
        toBlock: options.toBlock,
        ...(options.maximumLogRange === undefined
          ? {}
          : {
              maximumRange: options.maximumLogRange,
              initialRange: options.maximumLogRange,
            }),
        ...(options.maximumLogsPerResponse === undefined
          ? {}
          : { maximumLogsPerResponse: options.maximumLogsPerResponse }),
      });
      for (const rawLog of logs) {
        const log = rpcRecord(rawLog);
        const args = rpcRecord(log.args);
        const from = evmAddressSchema.parse(args.from);
        const to = evmAddressSchema.parse(args.to);
        const blockNumber = logInteger(log.blockNumber);
        const blockHash = evmHashSchema.parse(log.blockHash) as `0x${string}`;
        const previousHash = observedHashes.get(blockNumber);
        if (previousHash !== undefined && previousHash !== blockHash)
          throw new Error("Transfer logs disagree on block identity");
        observedHashes.set(blockNumber, blockHash);
        if (from.toLowerCase() !== BROKER && to.toLowerCase() !== BROKER)
          throw new Error("RPC returned an unfiltered token transfer");
        transfers.push({
          blockNumber,
          transactionHash: evmHashSchema.parse(log.transactionHash),
          logIndex: logInteger(log.logIndex),
          asset,
          from,
          to,
          amount: logInteger(args.value),
        });
      }
    }
  }
  const eventBlocks = new Set(
    options.operations
      .filter(
        (op) =>
          op.event === "SwapPerpsForUSD" || op.event === "SwapUSDForPerps",
      )
      .map((op) => op.blockNumber),
  );
  const upgradeLogs = await fetchLogsAdaptive({
    client: options.client,
    address: CONTRACTS.billBroker.address,
    event: UPGRADED,
    fromBlock: options.fromBlock + 1n,
    toBlock: options.toBlock,
    ...(options.maximumLogRange === undefined
      ? {}
      : {
          maximumRange: options.maximumLogRange,
          initialRange: options.maximumLogRange,
        }),
    ...(options.maximumLogsPerResponse === undefined
      ? {}
      : { maximumLogsPerResponse: options.maximumLogsPerResponse }),
  });
  const unverifiedBlocks = new Set(
    upgradeLogs.map((log) => logInteger(rpcRecord(log).blockNumber).toString()),
  );
  for (const block of eventBlocks) {
    if (unverifiedBlocks.has(block)) continue;
    try {
      // End-of-block identity alone cannot establish the runtime used earlier
      // in a block that changed implementations.
      await options.verifyBlock(BigInt(block) - 1n);
      await options.verifyBlock(BigInt(block));
    } catch {
      unverifiedBlocks.add(block);
    }
  }
  for (const [block, hash] of observedHashes)
    await options.verifyCanonicalBlock?.(block, hash);
  const ledger = buildBrokerLedger(
    options.fromBlock,
    options.toBlock,
    options.operations,
    transfers,
  );
  for (const event of ledger.events)
    if (unverifiedBlocks.has(event.blockNumber)) event.fee = null;
  return ledger;
}
