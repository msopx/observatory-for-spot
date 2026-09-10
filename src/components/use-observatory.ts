"use client";
import { useEffect, useState } from "react";
import { loadObservatoryFeed } from "../data/observatory-client";
import type {
  ObservatoryDatasetFor,
  ObservatoryFeed,
  ObservatoryFeedState,
  ObservatoryManifest,
} from "../data/observatory-schemas";
export type FeedView<F extends ObservatoryFeed> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      data: ObservatoryDatasetFor<F> | null;
      state: ObservatoryFeedState;
      manifest: ObservatoryManifest;
      refreshError: boolean;
    };
export function useObservatory<F extends ObservatoryFeed>(
  feed: F,
): FeedView<F> {
  const [view, setView] = useState<FeedView<F>>({ status: "loading" });
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const result = await loadObservatoryFeed(feed);
        if (active)
          setView({ status: "ready", ...result, refreshError: false });
      } catch {
        if (active)
          setView((previous) =>
            previous.status === "ready"
              ? { ...previous, refreshError: true }
              : {
                  status: "error",
                  error:
                    "Published data could not be loaded. Try reloading; the data page shows available archives.",
                },
          );
      }
    };
    void read();
    const interval = setInterval(() => void read(), 60_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [feed]);
  return view;
}
