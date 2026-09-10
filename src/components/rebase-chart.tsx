"use client";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { hasValidRate } from "../analytics/rebases";
import type { AmplRebaseRow } from "../data/schemas";
export function RebaseChart({ rows }: { rows: AmplRebaseRow[] }) {
  // A zero emitted rate means the market oracle had no valid rate; it is a
  // gap in the rate line, not a $0 observation.
  const points = rows.map((row) => ({
    time: Date.parse(row.timestamp),
    rate: hasValidRate(row) ? Number(row.exchangeRate) / 1e18 : null,
    target: Number(row.cpiAdjustedTargetRate) / 1e18,
  }));
  return (
    <>
      <div className="chart-legend">
        <span>
          <i className="legend-dot" style={{ background: "var(--accent)" }} />
          Exchange rate
        </span>
        <span>
          <i className="legend-dot" style={{ background: "var(--warning)" }} />
          CPI-adjusted target
        </span>
      </div>
      <div
        className="chart"
        role="img"
        aria-label="AMPL exchange rate and CPI-adjusted target over the selected date range"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={points}
            margin={{ left: -18, right: 8, top: 12, bottom: 4 }}
          >
            <CartesianGrid
              stroke="var(--border)"
              vertical={false}
              strokeDasharray="3 6"
            />
            <XAxis
              dataKey="time"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(value) =>
                new Date(value).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  timeZone: "UTC",
                })
              }
              minTickGap={35}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(value) => `$${Number(value).toFixed(2)}`}
              domain={["auto", "auto"]}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              labelFormatter={(value) =>
                new Date(Number(value)).toLocaleString("en-GB", {
                  timeZone: "UTC",
                }) + " UTC"
              }
              formatter={(value) =>
                value === null || value === undefined
                  ? "no valid rate"
                  : `$${Number(value).toFixed(5)}`
              }
            />
            <Line
              dataKey="rate"
              name="Exchange rate"
              stroke="var(--accent)"
              strokeWidth={2.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="target"
              name="CPI-adjusted target"
              stroke="var(--warning)"
              strokeWidth={1.5}
              strokeDasharray="5 5"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
