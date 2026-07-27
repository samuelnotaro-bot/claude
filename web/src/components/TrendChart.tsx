import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { formatCompactNumber, formatDate } from "../lib/format";

export interface TrendLine {
  dataKey: string;
  label: string;
  color: string;
}

/** Marks a data point flagged as a traffic-flood anomaly (see server anomaly.ts) with a red dot instead of the usual invisible line dot. */
function AnomalyDot({ cx, cy, payload }: { cx?: number; cy?: number; payload?: { isAnomaly?: boolean } }) {
  if (!payload?.isAnomaly || cx === undefined || cy === undefined) return null;
  return <circle cx={cx} cy={cy} r={4} fill="var(--critical)" stroke="var(--surface-1)" strokeWidth={1.5} />;
}

export function TrendChart({
  data,
  lines,
  valueFormatter = formatCompactNumber,
  height = 260,
  markAnomalies = false,
}: {
  data: Array<Record<string, unknown>>;
  lines: TrendLine[];
  valueFormatter?: (n: number) => string;
  height?: number;
  /** Highlight days flagged as a traffic-flood anomaly (`isAnomaly` on the data points) with a red dot. */
  markAnomalies?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => formatDate(d)}
          tick={{ fill: "var(--text-muted)", fontSize: 11 }}
          axisLine={{ stroke: "var(--baseline)" }}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis
          tickFormatter={(v: number) => valueFormatter(v)}
          tick={{ fill: "var(--text-muted)", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={48}
        />
        <Tooltip
          contentStyle={{
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelFormatter={(d: string) => formatDate(d)}
          formatter={(value: number, name: string) => [valueFormatter(value), name]}
        />
        {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }} />}
        {lines.map((l, i) => (
          <Line
            key={l.dataKey}
            type="monotone"
            dataKey={l.dataKey}
            name={l.label}
            stroke={l.color}
            strokeWidth={2}
            dot={markAnomalies && i === 0 ? <AnomalyDot /> : false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
