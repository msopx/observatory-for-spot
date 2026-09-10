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
export function ValueHistory({
  points,
  series,
  percent = false,
}: {
  points: Array<{ time: number; [key: string]: number | null }>;
  series: Array<{
    key: string;
    name: string;
    color: string;
    points?: Array<{ time: number; [key: string]: number | null }>;
  }>;
  percent?: boolean;
}) {
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={points}
          margin={{ left: -10, right: 12, top: 18, bottom: 4 }}
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
            minTickGap={40}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            domain={["auto", "auto"]}
            tickFormatter={(value) =>
              `${Number(value).toFixed(2)}${percent ? "%" : ""}`
            }
          />
          <Tooltip
            labelFormatter={(value) =>
              new Date(Number(value))
                .toISOString()
                .replace("T", " ")
                .slice(0, 19) + " UTC"
            }
          />
          {series.map((line) => (
            <Line
              key={line.key}
              {...(line.points ? { data: line.points } : {})}
              dataKey={line.key}
              name={line.name}
              stroke={line.color}
              strokeWidth={2}
              dot={{ r: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
