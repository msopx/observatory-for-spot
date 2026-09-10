import type { ZodType } from "zod";
import { sha256Hex } from "../lib/sha256";
import { observatoryManifestSchema } from "./observatory-schemas";

export async function loadDatasetResult<T>(
  filename: string,
  schema: ZodType<T>,
): Promise<{ data: T; sourceFailed: boolean }> {
  let sourceFailed = false;
  let path = `/data/${filename}`,
    expectedHash: string | undefined;
  const key = filename.replace(/\.json$/, "");
  if (
    key === "ampl-rebases" ||
    key === "spot-health" ||
    key === "broker-state"
  ) {
    const manifest = await fetch("/data/observatory-manifest.json", {
      cache: "no-cache",
      credentials: "omit",
    });
    if (manifest.ok) {
      const publication = observatoryManifestSchema.parse(
        await manifest.json(),
      );
      const published = publication.legacy?.[key];
      const feed =
        key === "ampl-rebases"
          ? "ampl-history"
          : key === "spot-health"
            ? "spot-history"
            : "broker-history";
      sourceFailed = publication.feeds[feed].status !== "ok";
      if (published) {
        path = published.path;
        expectedHash = published.contentHash;
      }
    } else if (manifest.status !== 404)
      throw new Error("The published data manifest could not be loaded.");
  }
  const response = await fetch(path, {
    cache: expectedHash ? "force-cache" : "no-cache",
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error(`Unable to load ${filename}: HTTP ${response.status}`);
  const raw = await response.text();
  if (expectedHash) {
    const actual = sha256Hex(raw);
    if (actual !== expectedHash)
      throw new Error("Published dataset does not match its manifest entry.");
  }
  return { data: schema.parse(JSON.parse(raw)), sourceFailed };
}

export async function loadDataset<T>(
  filename: string,
  schema: ZodType<T>,
): Promise<T> {
  return (await loadDatasetResult(filename, schema)).data;
}
