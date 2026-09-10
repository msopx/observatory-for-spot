import type {
  ObservatoryLogClient,
  ObservatoryPublicClient,
  RpcBlock,
} from "../src/data/refresh";

const DEFAULT_INTERVAL_MS = 250;
const MAX_RATE_LIMIT_RETRIES = 8;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRateLimit(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (
    current !== null &&
    typeof current === "object" &&
    !visited.has(current)
  ) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    const text = [
      record.name,
      record.message,
      record.shortMessage,
      record.details,
      record.status,
      record.statusCode,
    ]
      .filter((value): value is string | number =>
        ["string", "number"].includes(typeof value),
      )
      .join(" ");
    if (/\b429\b|rate limit|defined limit|too many requests/i.test(text)) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/**
 * Serializes public-RPC requests and retries only explicit rate-limit errors.
 * This is operational flow control, not a cache: every successful response
 * still comes from the configured RPC endpoint.
 */
class PublicRpcScheduler {
  private tail: Promise<void> = Promise.resolve();
  private nextStart = 0;

  constructor(private readonly intervalMs: number) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const delay = Math.max(0, this.nextStart - Date.now());
      if (delay > 0) {
        await wait(delay);
      }
      this.nextStart = Date.now() + this.intervalMs;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await operation();
        } catch (error) {
          if (!isRateLimit(error) || attempt >= MAX_RATE_LIMIT_RETRIES) {
            throw error;
          }
          await wait(Math.min(15_000, 1_000 * 2 ** attempt));
          this.nextStart = Date.now() + this.intervalMs;
        }
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Wraps the narrow client interface used by release collection. A shared
 * scheduler means contract calls, block reads and logs cannot burst the same
 * no-key public endpoint concurrently.
 */
export function rateLimitedPublicClient(
  client: ObservatoryPublicClient,
  intervalMs = DEFAULT_INTERVAL_MS,
): ObservatoryPublicClient {
  const scheduler = new PublicRpcScheduler(intervalMs);
  return {
    getChainId: () => scheduler.run(() => client.getChainId()),
    getBlock: (
      request:
        | { readonly blockHash: `0x${string}` }
        | { readonly blockNumber: bigint },
    ): Promise<RpcBlock> => scheduler.run(() => client.getBlock(request)),
    readContract: (request: Readonly<Record<string, unknown>>) =>
      scheduler.run(() => client.readContract(request)),
    getCode: (request: {
      readonly address: `0x${string}`;
      readonly blockNumber: bigint;
    }) => scheduler.run(() => client.getCode(request)),
    getStorageAt: (request: {
      readonly address: `0x${string}`;
      readonly blockNumber: bigint;
      readonly slot: `0x${string}`;
    }) => scheduler.run(() => client.getStorageAt(request)),
    getLogs: (request: Parameters<ObservatoryLogClient["getLogs"]>[0]) =>
      scheduler.run(() => client.getLogs(request)),
  };
}
