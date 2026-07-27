import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { formatCompactNumber, formatDate } from "../lib/format";

export interface TrendLine {
  dataKey: string;
  label: string;
  color: string;
}

export function TrendChart({
  data,
  lines,
  valueFormatter = formatCompactNumber,
  height = 260,
}: {
  data: Array<Record<string, unknown>>;
  lines: TrendLine[];
  valueFormatter?: (n: number) => string;
  height?: number;
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
        {lines.map((l) => (
          <Line
            key={l.dataKey}
            type="monotone"
            dataKey={l.dataKey}
            name={l.label}
            stroke={l.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
