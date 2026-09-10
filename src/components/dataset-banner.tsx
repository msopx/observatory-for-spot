"use client";
import { useNow } from "./use-now";
import Link from "next/link";
import { dateLabel } from "../lib/display";
export function RefreshWarning({ failed }: { failed: boolean }) {
  return failed ? (
    <div className="status warning" role="status">
      <span className="dot" />A data refresh failed. The last successfully loaded
      observations are shown.
      <Link href="/data/">Inspect source status ↗</Link>
    </div>
  ) : null;
}
export function DatasetBanner({
  status,
  blockNumber,
  blockHash,
  timestamp,
}: Readonly<{
  status: "fixture" | "release";
  blockNumber: string;
  blockHash: string;
  timestamp?: string | undefined;
}>) {
  const now = useNow();
  const stale =
    timestamp && now ? now - Date.parse(timestamp) > 36 * 3_600_000 : true;
  return (
    <div className={`status ${status === "fixture" || stale ? "warning" : ""}`}>
      <span className="dot" />
      <span>
        {status === "fixture"
          ? "Development dataset"
          : stale
            ? "Historical snapshot"
            : "Indexed snapshot"}
        {timestamp ? ` · ${dateLabel(timestamp, true)} UTC` : ""} · block{" "}
        {BigInt(blockNumber).toLocaleString("en-US")} · {blockHash.slice(0, 10)}
        …
      </span>
      <Link href="/data/">Data sources ↗</Link>
    </div>
  );
}
