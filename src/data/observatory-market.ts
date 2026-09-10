import {
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  parseAbi,
  parseAbiItem,
} from "viem";

import { CONTRACTS } from "./contracts";
import {
  observatoryDatasetSchema,
  type ObservatoryDatasetFor,
  type SpotMarketPoint,
  type MarketSwap,
} from "./observatory-schemas";
import {
  fetchLogsAdaptive,
  type ObservatoryLogClient,
  type ObservatoryPublicClient,
  type ResolvedReleaseBlock,
} from "./refresh";
import { evmAddressSchema, evmHashSchema } from "./schemas";

// Deployment/CREATE2 constants: Uniswap v3-sdk/src/constants.ts.
// Event semantics: v3-core v1.0.0 IUniswapV3PoolEvents/State/Immutables.
export const SPOT_MARKET_POOL = {
  address: "0x898aDC9aa0C23DCE3fED6456C34DbE2b57784325",
  factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  token0: CONTRACTS.usdc.address,
  token1: CONTRACTS.spot.address,
  fee: 10_000n,
  tickSpacing: 200n,
  initCodeHash:
    "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54",
  // All 22,142 runtime bytes matched the explorer's deployed bytecode and
  // Ethereum at blocks 25276141 and 25916954. This is this pool's immutable
  // runtime, not a generic hash for other Uniswap pools.
  // https://etherscan.io/address/0x898adc9aa0c23dce3fed6456c34dbe2b57784325#code
  runtimeCodeHash:
    "0x7c06da9cbc2c7692833fddc2eced589e0014f25e6816e5a13dfe6390cfb8047b",
} as const;
const POOL_ABI = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);
const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);
const DECIMALS_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const SWAP = parseAbiItem(
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
);
const DAY = 86_400n;
type MarketDataset = ObservatoryDatasetFor<"spot-market">;

class MarketHistoryError extends Error {}
function fail(message: string): never {
  throw new MarketHistoryError(message);
}
function integer(value: unknown, bits: number, signed = false): bigint {
  const result =
    typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : null;
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = signed
    ? (1n << BigInt(bits - 1)) - 1n
    : (1n << BigInt(bits)) - 1n;
  if (result === null || result < min || result > max)
    fail("Invalid market event integer");
  return result;
}
function hash(value: unknown): `0x${string}` {
  const parsed = evmHashSchema.safeParse(value);
  if (!parsed.success) fail("Invalid market block or transaction hash");
  return parsed.data.toLowerCase() as `0x${string}`;
}
function addressMatches(value: unknown, expected: string): boolean {
  const parsed = evmAddressSchema.safeParse(value);
  return parsed.success && parsed.data.toLowerCase() === expected.toLowerCase();
}
function iso(seconds: bigint): string {
  const milliseconds = Number(seconds * 1_000n);
  if (!Number.isSafeInteger(milliseconds)) fail("Invalid market timestamp");
  return new Date(milliseconds).toISOString();
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") fail("Invalid market log");
  return value as Record<string, unknown>;
}

async function mapBounded<T, R>(
  values: readonly T[],
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const results = new Array<R>(values.length);
  await Promise.all(
    Array.from({ length: Math.min(4, values.length) }, async () => {
      while (!failed && cursor < values.length) {
        const index = cursor++;
        try {
          results[index] = await task(values[index]!);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}

/** USDC per SPOT, rounded down to 18 decimals. Raw Q64.96 evidence is retained. */
export function spotPoolPriceQuote(sqrtPriceX96: bigint): string {
  if (sqrtPriceX96 <= 0n || sqrtPriceX96 >= 1n << 160n)
    fail("Invalid market square-root price");
  // token1/token0 = SPOT raw / USDC raw; invert and adjust 9 versus 6 decimals.
  return (
    ((1n << 192n) * 10n ** 21n) /
    (sqrtPriceX96 * sqrtPriceX96)
  ).toString();
}

export interface SpotMarketHistoryOptions {
  client: ObservatoryPublicClient;
  logClient?: ObservatoryLogClient;
  release: ResolvedReleaseBlock;
  now?: Date;
  historyDays?: number;
  previous?: MarketDataset | null;
}

async function collectSpotMarketHistory(
  options: SpotMarketHistoryOptions,
): Promise<MarketDataset> {
  const { client, release } = options;
  const now = options.now ?? new Date();
  const days = options.historyDays ?? 90;
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > 365 ||
    !Number.isFinite(now.getTime())
  )
    fail("Market history requires 1 to 365 completed days");
  if ((await client.getChainId()) !== 1)
    fail("Market history requires Ethereum mainnet");
  const wallTime = BigInt(Math.floor(now.getTime() / 1_000));
  if (release.number <= 0n || release.timestamp > wallTime)
    fail("Market release block is outside the observation window");
  const end = (release.timestamp / DAY) * DAY;
  const start = end - BigInt(days) * DAY;
  if (start < 0n) fail("Market history precedes Ethereum block coverage");

  const blocks = new Map<bigint, Promise<ResolvedReleaseBlock>>();
  const blockAt = (number: bigint): Promise<ResolvedReleaseBlock> => {
    if (number < 1n || number > release.number)
      fail("Market block lies outside the release boundary");
    let pending = blocks.get(number);
    if (pending === undefined) {
      pending = client.getBlock({ blockNumber: number }).then((block) => {
        if (block.number !== number)
          fail("Market provider returned a different block");
        const timestamp = integer(block.timestamp, 64);
        if (timestamp > release.timestamp)
          fail("Market block timestamp exceeds the release boundary");
        return {
          number,
          hash: hash(block.hash),
          timestamp,
          timestampIso: iso(timestamp),
        };
      });
      blocks.set(number, pending);
    }
    return pending;
  };
  const observedRelease = await blockAt(release.number);
  if (
    observedRelease.hash !== hash(release.hash) ||
    observedRelease.timestamp !== release.timestamp
  )
    fail("Market release block identity changed");

  const pinned = (
    address: `0x${string}`,
    abi: unknown,
    functionName: string,
    args?: readonly unknown[],
  ) =>
    client.readContract({
      address,
      abi,
      functionName,
      blockNumber: release.number,
      ...(args === undefined ? {} : { args }),
    });
  const [
    factory,
    token0,
    token1,
    fee,
    spacing,
    membership,
    baseDecimals,
    quoteDecimals,
  ] = await Promise.all([
    pinned(SPOT_MARKET_POOL.address, POOL_ABI, "factory"),
    pinned(SPOT_MARKET_POOL.address, POOL_ABI, "token0"),
    pinned(SPOT_MARKET_POOL.address, POOL_ABI, "token1"),
    pinned(SPOT_MARKET_POOL.address, POOL_ABI, "fee"),
    pinned(SPOT_MARKET_POOL.address, POOL_ABI, "tickSpacing"),
    pinned(SPOT_MARKET_POOL.factory, FACTORY_ABI, "getPool", [
      SPOT_MARKET_POOL.token0,
      SPOT_MARKET_POOL.token1,
      Number(SPOT_MARKET_POOL.fee),
    ]),
    pinned(CONTRACTS.spot.address, DECIMALS_ABI, "decimals"),
    pinned(CONTRACTS.usdc.address, DECIMALS_ABI, "decimals"),
  ]);
  const runtime = await client.getCode({
    address: SPOT_MARKET_POOL.address,
    blockNumber: release.number,
  });
  const salt = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }],
      [
        SPOT_MARKET_POOL.token0,
        SPOT_MARKET_POOL.token1,
        Number(SPOT_MARKET_POOL.fee),
      ],
    ),
  );
  const expected = getCreate2Address({
    from: SPOT_MARKET_POOL.factory,
    salt,
    bytecodeHash: SPOT_MARKET_POOL.initCodeHash,
  });
  if (
    !addressMatches(expected, SPOT_MARKET_POOL.address) ||
    !addressMatches(factory, SPOT_MARKET_POOL.factory) ||
    !addressMatches(token0, SPOT_MARKET_POOL.token0) ||
    !addressMatches(token1, SPOT_MARKET_POOL.token1) ||
    !addressMatches(membership, SPOT_MARKET_POOL.address) ||
    integer(fee, 24) !== SPOT_MARKET_POOL.fee ||
    integer(spacing, 24, true) !== SPOT_MARKET_POOL.tickSpacing ||
    integer(baseDecimals, 8) !== 9n ||
    integer(quoteDecimals, 8) !== 6n ||
    runtime === undefined ||
    !/^0x(?:[a-fA-F0-9]{2})+$/.test(runtime)
  )
    fail("SPOT market pool identity does not match the recorded pool");
  const codeHash = keccak256(runtime);
  if (codeHash !== SPOT_MARKET_POOL.runtimeCodeHash)
    fail("SPOT market pool runtime does not match the recorded hash");
  const pool = {
    address: SPOT_MARKET_POOL.address,
    factory: SPOT_MARKET_POOL.factory,
    token0: SPOT_MARKET_POOL.token0,
    token1: SPOT_MARKET_POOL.token1,
    baseToken: {
      address: CONTRACTS.spot.address,
      name: "SPOT",
      symbol: "SPOT",
      decimals: "9",
    },
    quoteToken: {
      address: CONTRACTS.usdc.address,
      name: "USD Coin",
      symbol: "USDC",
      decimals: "6",
    },
    fee: "10000" as const,
    tickSpacing: "200" as const,
    codeHash,
    verifiedAt: {
      blockNumber: release.number.toString(),
      blockHash: observedRelease.hash,
      timestamp: observedRelease.timestampIso,
    },
  };

  const previous =
    options.previous === undefined || options.previous === null
      ? null
      : (observatoryDatasetSchema.parse(options.previous) as MarketDataset);
  const oldRows = new Map<string, SpotMarketPoint>();
  const previousLast = previous?.rows.at(-1);
  if (previous !== null) {
    if (
      previous.feed !== "spot-market" ||
      previous.source !== "ethereum-rpc" ||
      !addressMatches(previous.pool.address, pool.address) ||
      previous.pool.codeHash.toLowerCase() !== pool.codeHash.toLowerCase()
    )
      fail("Previous market history identifies a different source or pool");
    let priorEnd: string | undefined;
    for (const row of previous.rows) {
      const rowStart = BigInt(Date.parse(row.periodStart) / 1_000);
      const rowEnd = BigInt(Date.parse(row.timestamp) / 1_000);
      if (
        rowStart % DAY !== 0n ||
        rowEnd - rowStart !== DAY ||
        rowEnd > end ||
        (priorEnd !== undefined && row.periodStart !== priorEnd)
      )
        fail("Previous market history has invalid daily coverage");
      priorEnd = row.timestamp;
      oldRows.set(row.timestamp, row);
    }
    if (previousLast !== undefined) {
      const boundary = await blockAt(BigInt(previousLast.toBlock));
      if (boundary.hash !== hash(previousLast.toBlockHash))
        fail("Previous market boundary is no longer canonical");
    }
  }

  // Find actual UTC boundaries. Header searches are cached; estimated block
  // times never become evidence. Every day is a half-open time interval.
  const boundaries = new Map<bigint, bigint>();
  const firstAtOrAfter = async (timestamp: bigint): Promise<bigint> => {
    const cached = boundaries.get(timestamp);
    if (cached !== undefined) return cached;
    let low = 1n;
    let high = release.number;
    while (low < high) {
      const mid = (low + high) / 2n;
      if ((await blockAt(mid)).timestamp < timestamp) low = mid + 1n;
      else high = mid;
    }
    const at = await blockAt(low);
    if (
      at.timestamp < timestamp ||
      (low > 1n && (await blockAt(low - 1n)).timestamp >= timestamp)
    )
      fail("Market provider could not establish a UTC block boundary");
    boundaries.set(timestamp, low);
    return low;
  };

  const canonical = new Map<bigint, `0x${string}`>([
    [release.number, observedRelease.hash],
  ]);
  if (previousLast !== undefined)
    canonical.set(BigInt(previousLast.toBlock), hash(previousLast.toBlockHash));
  const dayStarts = Array.from(
    { length: days },
    (_, index) => start + BigInt(index) * DAY,
  );
  // Even after a long outage or a shorter requested window, re-read the last
  // previously completed day before trusting its history boundary.
  if (previousLast !== undefined) {
    const lastStart = BigInt(Date.parse(previousLast.periodStart) / 1_000);
    if (lastStart < start) dayStarts.unshift(lastStart);
  }
  const neededBoundaries = new Set<bigint>();
  for (const dayStart of dayStarts) {
    const old = oldRows.get(iso(dayStart + DAY));
    if (old === undefined || old.timestamp === previousLast?.timestamp) {
      neededBoundaries.add(dayStart);
      neededBoundaries.add(dayStart + DAY);
    }
  }
  await mapBounded([...neededBoundaries], firstAtOrAfter);
  const transactionBlocks = new Map<string, string>();
  const rows = await mapBounded(
    dayStarts,
    async (dayStart): Promise<SpotMarketPoint> => {
      const dayEnd = dayStart + DAY;
      const timestamp = iso(dayEnd);
      const old = oldRows.get(timestamp);
      if (old !== undefined && old.timestamp !== previousLast?.timestamp) {
        return old;
      }
      const fromBlock = await firstAtOrAfter(dayStart);
      const toBlock = (await firstAtOrAfter(dayEnd)) - 1n;
      if (fromBlock > toBlock)
        fail("A market day has no verifiable Ethereum block interval");
      const boundary = await blockAt(toBlock);
      canonical.set(toBlock, boundary.hash);
      const rawLogs = await fetchLogsAdaptive({
        client: options.logClient ?? client,
        address: SPOT_MARKET_POOL.address,
        event: SWAP,
        fromBlock,
        toBlock,
        initialRange: 10_000n,
        maximumRange: 10_000n,
        maximumLogsPerResponse: 1_000,
      });
      const unique = new Map<string, MarketSwap>();
      const logParties = new Map<string, string>();
      const transactionIdentities = new Map<string, string>();
      for (const raw of rawLogs) {
        const log = record(raw);
        if (
          !addressMatches(log.address, SPOT_MARKET_POOL.address) ||
          log.removed !== false ||
          log.eventName !== "Swap"
        )
          fail("Market provider returned a pool log outside the requested pool");
        const number = integer(log.blockNumber, 64);
        if (number < fromBlock || number > toBlock)
          fail("Market swap lies outside its requested interval");
        const block = await blockAt(number);
        if (
          block.hash !== hash(log.blockHash) ||
          block.timestamp < dayStart ||
          block.timestamp >= dayEnd
        )
          fail("Market swap disagrees with its canonical block");
        canonical.set(number, block.hash);
        const args = record(log.args);
        const sender = evmAddressSchema.safeParse(args.sender);
        const recipient = evmAddressSchema.safeParse(args.recipient);
        if (!sender.success || !recipient.success)
          fail("Market swap is missing its sender or recipient");
        const sqrtPrice = integer(args.sqrtPriceX96, 160);
        spotPoolPriceQuote(sqrtPrice);
        const tick = integer(args.tick, 24, true);
        if (tick < -887_272n || tick > 887_272n)
          fail("Market swap tick is outside the pool range");
        const entry: MarketSwap = {
          blockNumber: number.toString(),
          blockHash: block.hash,
          timestamp: block.timestampIso,
          transactionHash: hash(log.transactionHash),
          transactionIndex: integer(log.transactionIndex, 64).toString(),
          logIndex: integer(log.logIndex, 64).toString(),
          sqrtPriceX96: sqrtPrice.toString(),
          tick: tick.toString(),
          liquidity: integer(args.liquidity, 128).toString(),
          amount0: integer(args.amount0, 256, true).toString(),
          amount1: integer(args.amount1, 256, true).toString(),
        };
        const transactionId = `${entry.blockNumber}:${entry.transactionIndex}`;
        const existingBlock = transactionBlocks.get(entry.transactionHash);
        if (existingBlock !== undefined && existingBlock !== transactionId)
          fail(
            "Market transaction appears in inconsistent blocks or positions",
          );
        transactionBlocks.set(entry.transactionHash, transactionId);
        const previousTransaction = transactionIdentities.get(transactionId);
        if (
          previousTransaction !== undefined &&
          previousTransaction !== entry.transactionHash
        )
          fail("Market logs conflict on transaction identity");
        transactionIdentities.set(transactionId, entry.transactionHash);
        const id = `${number}:${entry.logIndex}`;
        const parties = `${sender.data.toLowerCase()}:${recipient.data.toLowerCase()}`;
        const duplicate = unique.get(id);
        if (
          duplicate !== undefined &&
          (JSON.stringify(duplicate) !== JSON.stringify(entry) ||
            logParties.get(id) !== parties)
        )
          fail("Market logs conflict on swap identity");
        unique.set(id, entry);
        logParties.set(id, parties);
      }
      const swaps = [...unique.values()].sort((a, b) => {
        const byBlock = BigInt(a.blockNumber) - BigInt(b.blockNumber);
        const difference =
          byBlock === 0n ? BigInt(a.logIndex) - BigInt(b.logIndex) : byBlock;
        return difference < 0n ? -1 : difference > 0n ? 1 : 0;
      });
      for (let i = 1; i < swaps.length; i++) {
        const before = swaps[i - 1]!;
        const after = swaps[i]!;
        if (
          before.blockNumber === after.blockNumber &&
          BigInt(before.transactionIndex) > BigInt(after.transactionIndex)
        )
          fail("Market logs have inconsistent transaction ordering");
      }
      const lastSwap = swaps.at(-1) ?? null;
      const row: SpotMarketPoint = {
        timestamp,
        periodStart: iso(dayStart),
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        toBlockHash: boundary.hash,
        swapCount: swaps.length.toString(),
        volumeQuote: swaps
          .reduce((sum, swap) => {
            const amount = BigInt(swap.amount0);
            return sum + (amount < 0n ? -amount : amount);
          }, 0n)
          .toString(),
        priceQuote:
          lastSwap === null
            ? null
            : spotPoolPriceQuote(BigInt(lastSwap.sqrtPriceX96)),
        lastSwap,
      };
      if (
        old !== undefined &&
        JSON.stringify(row) !== JSON.stringify({ ...row, ...old })
      )
        fail("Previously completed market day changed on re-read");
      return row;
    },
  );
  await mapBounded([...canonical], async ([number, expectedHash]) => {
    const current = await client.getBlock({ blockNumber: number });
    if (current.number !== number || hash(current.hash) !== expectedHash)
      fail("Market block changed during collection");
  });
  return observatoryDatasetSchema.parse({
    schemaVersion: 2,
    feed: "spot-market",
    source: "ethereum-rpc",
    chainId: 1,
    generatedAt: now.toISOString(),
    pool,
    rows: rows.filter((row) => row.periodStart >= iso(start)),
    notes: [
      "Ethereum Swap events read from the Uniswap V3 SPOT/USDC 1% pool at its recorded identity; all amounts are integer token units.",
      "Each row covers one completed UTC day. The last Swap records the post-swap marginal pool price in USDC per SPOT, rounded down to 18 decimals; it is not USD or an executable quote.",
      "Quiet days have no price and are never forward-filled. Event timestamps and raw Q64.96 prices remain attached to the final swap. Zero-volume and zero-liquidity events are preserved.",
      "Volume is the sum of absolute USDC deltas across unique Swap events, in six-decimal token units. Event liquidity is active pool liquidity, not USD TVL or trade depth.",
    ],
  }) as MarketDataset;
}

/** Caller retains last-good data on failure; raw provider errors never escape. */
export async function readSpotMarketHistory(
  options: SpotMarketHistoryOptions,
): Promise<MarketDataset> {
  try {
    return await collectSpotMarketHistory(options);
  } catch (error) {
    if (error instanceof MarketHistoryError) throw error;
    throw new MarketHistoryError(
      "Ethereum market collection failed; complete coverage was not collected",
    );
  }
}
