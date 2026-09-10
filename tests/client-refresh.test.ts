import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { loadDatasetResult } from "../src/data/client";
import { observatoryManifestSchema } from "../src/data/observatory-schemas";
import { brokerStateDatasetSchema } from "../src/data/schemas";

afterEach(() => vi.unstubAllGlobals());
it("keeps a retained dashboard payload while surfacing a failed source refresh", async () => {
  const manifest = observatoryManifestSchema.parse(
    JSON.parse(readFileSync("public/data/observatory-manifest.json", "utf8")),
  );
  const feed = manifest.feeds["broker-history"];
  manifest.feeds["broker-history"] = {
    ...feed,
    status: "error",
    message: "read-failed",
  };
  const published = manifest.legacy!["broker-state"]!;
  const body = readFileSync(`public${published.path}`, "utf8");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: string) =>
        new Response(
          input.endsWith("observatory-manifest.json")
            ? JSON.stringify(manifest)
            : body,
        ),
    ),
  );
  const result = await loadDatasetResult(
    "broker-state.json",
    brokerStateDatasetSchema,
  );
  expect(result.sourceFailed).toBe(true);
  expect(result.data.metadata.blockHash).toBe(
    JSON.parse(body).metadata.blockHash,
  );
});
it("rejects a dashboard payload whose bytes do not match its manifest", async () => {
  const manifest = JSON.parse(
    readFileSync("public/data/observatory-manifest.json", "utf8"),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: string) =>
        new Response(
          input.endsWith("observatory-manifest.json")
            ? JSON.stringify(manifest)
            : "{}",
        ),
    ),
  );
  await expect(
    loadDatasetResult("broker-state.json", brokerStateDatasetSchema),
  ).rejects.toThrow("does not match its manifest entry");
});
