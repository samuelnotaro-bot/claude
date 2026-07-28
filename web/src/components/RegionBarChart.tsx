import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from "recharts";
import type { RegionSummary } from "../lib/api";
import { formatCompactNumber } from "../lib/format";

const SERIES_COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
];

export function RegionBarChart({ data }: { data: RegionSummary[] }) {
  const sorted = [...data].sort((a, b) => b.sessions - a.sessions);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={sorted} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--gridline)" vertical={false} />
        <XAxis
          dataKey="region"
          tick={{ fill: "var(--text-muted)", fontSize: 11 }}
          axisLine={{ stroke: "var(--baseline)" }}
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v: number) => formatCompactNumber(v)}
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
          formatter={(value: number) => [formatCompactNumber(value), "Sessions"]}
        />
        <Bar dataKey="sessions" radius={[4, 4, 0, 0]} maxBarSize={40}>
          {sorted.map((_, i) => (
            <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
