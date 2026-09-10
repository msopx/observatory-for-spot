"use client";
import { useState } from "react";
import type { AmplRebaseRow } from "../data/schemas";
import {
  hasValidRate,
  monthCells,
  offsetMonth,
  rebaseDirection,
} from "../analytics/rebases";
import { dateLabel, token, usd } from "../lib/display";
export function RebaseCalendar({ rows }: { rows: AmplRebaseRow[] }) {
  const latest = rows.at(-1);
  const [month, setMonth] = useState(
    latest?.timestamp.slice(0, 7) ?? "2026-01",
  );
  const [selected, setSelected] = useState(
    latest?.timestamp.slice(0, 10) ?? "",
  );
  const byDay = new Map<string, AmplRebaseRow[]>();
  for (const row of rows) {
    const day = row.timestamp.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  const selectedRows = byDay.get(selected) ?? [];
  return (
    <>
      <div className="calendar-header">
        <button
          type="button"
          className="secondary"
          aria-label="Previous month"
          onClick={() => setMonth(offsetMonth(month, -1))}
        >
          ←
        </button>
        <h3>
          {new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          })}
        </h3>
        <button
          type="button"
          className="secondary"
          aria-label="Next month"
          onClick={() => setMonth(offsetMonth(month, 1))}
        >
          →
        </button>
      </div>
      <div className="calendar-grid">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <span className="calendar-day-name" key={day}>
            {day}
          </span>
        ))}
        {monthCells(month).map((day, i) => {
          const entries = day ? byDay.get(day) : undefined;
          const row = entries?.at(-1);
          const change = row?.supplyChangePercent;
          return day ? (
            <button
              className={`calendar-day ${row ? rebaseDirection(row) : ""}`}
              key={day}
              disabled={!row}
              aria-label={`${day}: ${row ? `${change ?? "unknown"}% actual supply change${entries!.length > 1 ? `, ${entries!.length} epochs` : ""}` : "no indexed epoch"}`}
              aria-pressed={selected === day}
              onClick={() => setSelected(day)}
              type="button"
            >
              <span>{Number(day.slice(-2))}</span>
              <small>
                {change !== null && change !== undefined
                  ? `${Number(change) > 0 ? "+" : ""}${Number(change).toFixed(2)}%`
                  : "—"}
              </small>
            </button>
          ) : (
            <span key={`empty-${i}`} />
          );
        })}
      </div>
      <div className="chart-legend">
        <span className="positive">● Expansion</span>
        <span className="negative">● Contraction</span>
        <span>— No indexed epoch</span>
      </div>
      <div className="calendar-selected">
        {selectedRows.length
          ? selectedRows.map((row) => (
              <div key={`${row.transactionHash}-${row.epoch}`}>
                <strong>
                  {dateLabel(row.timestamp)} · Epoch {row.epoch}
                </strong>
                <p>
                  <span
                    className={
                      rebaseDirection(row) === "contraction"
                        ? "negative"
                        : "positive"
                    }
                  >
                    {row.supplyChangePercent === null
                      ? "Actual change unavailable"
                      : `${Number(row.supplyChangePercent) > 0 ? "+" : ""}${Number(row.supplyChangePercent).toFixed(4)}% actual supply change`}
                  </span>
                </p>
                <p className="muted small">
                  {hasValidRate(row)
                    ? `Rate ${usd(row.exchangeRate)}`
                    : "No valid market rate reported"}{" "}
                  · target {usd(row.cpiAdjustedTargetRate)}
                  <br />
                  {token(row.totalSupply, 9, 0)} AMPL after rebase
                </p>
              </div>
            ))
          : "Select an indexed day to inspect its rebase."}
      </div>
    </>
  );
}
