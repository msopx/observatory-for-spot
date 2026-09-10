"use client";
import Link from "next/link";
import { useNow } from "./use-now";
import type { ObservatoryFeed } from "../data/observatory-schemas";
import { dateLabel } from "../lib/display";
import type { FeedView } from "./use-observatory";
export function FeedStatus<F extends ObservatoryFeed>({
  feed,
  label,
}: {
  feed: FeedView<F>;
  label: string;
}) {
  const now = useNow();
  if (feed.status === "loading")
    return <p className="muted small">Loading {label.toLowerCase()}…</p>;
  if (feed.status === "error")
    return (
      <div className="status warning">
        <span className="dot" />
        {label}: archive unavailable. <Link href="/data/">Data status ↗</Link>
      </div>
    );
  const stale =
    !feed.state.observedAt ||
    !now ||
    now - Date.parse(feed.state.observedAt) > 36 * 3_600_000;
  return (
    <div
      className={`status ${stale || feed.state.status !== "ok" || feed.refreshError ? "warning" : ""}`}
    >
      <span className="dot" />
      <span>
        {label} ·{" "}
        {feed.state.observedAt
          ? `${stale ? "Historical snapshot" : "Observed"} ${dateLabel(feed.state.observedAt, true)} UTC`
          : "No published observations"}
        {feed.state.status !== "ok" && feed.state.path
          ? " · last published data retained"
          : ""}
        {feed.refreshError ? " · refresh check failed" : ""}
      </span>
      <Link href="/data/">Sources & coverage ↗</Link>
    </div>
  );
}
export function FeedEmpty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
