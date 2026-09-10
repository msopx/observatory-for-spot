import { sha256Hex } from "../lib/sha256";
import {
  observatoryDatasetSchema,
  observatoryManifestSchema,
  type ObservatoryDatasetFor,
  type ObservatoryFeed,
  type ObservatoryFeedState,
  type ObservatoryManifest,
} from "./observatory-schemas";

export type ObservatoryFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export async function loadObservatoryManifest(
  fetcher: ObservatoryFetch = fetch,
): Promise<ObservatoryManifest> {
  const response = await fetcher("/data/observatory-manifest.json", {
    cache: "no-cache",
    credentials: "omit",
  });
  if (!response.ok) throw new Error("Observatory manifest is unavailable");
  return observatoryManifestSchema.parse(await response.json());
}

export async function loadPublishedObservatoryFeed<F extends ObservatoryFeed>(
  feed: F,
  manifest: ObservatoryManifest,
  fetcher: ObservatoryFetch = fetch,
): Promise<ObservatoryDatasetFor<F> | null> {
  const state = manifest.feeds[feed];
  if (state.path === null) return null;
  const response = await fetcher(state.path, {
    cache: "force-cache",
    credentials: "omit",
  });
  if (!response.ok)
    throw new Error("Published observatory feed is unavailable");
  const raw = await response.text();
  const actualHash = sha256Hex(raw);
  if (actualHash !== state.contentHash)
    throw new Error("Observatory feed does not match its manifest entry");
  const dataset = observatoryDatasetSchema.parse(JSON.parse(raw));
  if (dataset.feed !== feed || dataset.rows.length !== state.rowCount) {
    throw new Error("Observatory feed does not match its manifest");
  }
  return dataset as ObservatoryDatasetFor<F>;
}

export async function loadObservatoryFeed<F extends ObservatoryFeed>(
  feed: F,
  fetcher: ObservatoryFetch = fetch,
): Promise<{
  manifest: ObservatoryManifest;
  state: ObservatoryFeedState;
  data: ObservatoryDatasetFor<F> | null;
}> {
  const manifest = await loadObservatoryManifest(fetcher);
  const data = await loadPublishedObservatoryFeed(feed, manifest, fetcher);
  return { manifest, state: manifest.feeds[feed], data };
}

export function feedFreshness(
  state: ObservatoryFeedState,
  now: Date = new Date(),
  staleAfterHours = 36,
): { ageHours: number | null; stale: boolean; retained: boolean } {
  const ageHours =
    state.observedAt === null
      ? null
      : Math.max(0, (now.getTime() - Date.parse(state.observedAt)) / 3_600_000);
  return {
    ageHours,
    stale: ageHours === null || ageHours > staleAfterHours,
    retained: state.status !== "ok" && state.path !== null,
  };
}
