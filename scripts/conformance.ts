import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

import { runConformance } from "../src/data/conformance";
import {
  parseReleaseBlockRequest,
  type ObservatoryPublicClient,
} from "../src/data/refresh";
import { DATA_SCHEMA_VERSION } from "../src/data/schemas";
import { stableJsonStringify } from "../src/data/writers";

function requiredRpcUrl(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error("ETHEREUM_RPC_URL is required");
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error(
      "ETHEREUM_RPC_URL must be an HTTP(S) URL without URL-embedded credentials",
    );
  }
  return value;
}

export async function main(): Promise<void> {
  const refreshConfiguration = JSON.parse(
    await readFile("release/refresh-config.json", "utf8"),
  ) as {
    readonly releaseBlock: {
      readonly number: string;
      readonly hash: string;
    };
  };
  const rpcUrl = requiredRpcUrl(process.env.ETHEREUM_RPC_URL);
  const releaseBlock = parseReleaseBlockRequest(
    process.env.RELEASE_BLOCK ?? refreshConfiguration.releaseBlock.number,
    process.env.RELEASE_BLOCK_HASH ?? refreshConfiguration.releaseBlock.hash,
  );
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  }) as unknown as ObservatoryPublicClient;
  const report = await runConformance({ client, releaseBlock });
  const output = stableJsonStringify(report);
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/rpc-conformance.json", output, {
    encoding: "utf8",
    mode: 0o644,
  });
  process.stdout.write(output);
  if (!report.passed) {
    process.exitCode = 1;
  }
}

function configurationFailure(): string {
  return stableJsonStringify({
    schemaVersion: DATA_SCHEMA_VERSION,
    report: "ethereum-rpc-conformance",
    passed: false,
    error: {
      code: "configuration-or-rpc-failure",
      message:
        "Conformance could not complete with the supplied release block and RPC configuration.",
    },
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main().catch(() => {
    process.stdout.write(configurationFailure());
    process.exitCode = 1;
  });
}
