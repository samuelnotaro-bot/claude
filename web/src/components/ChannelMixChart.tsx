import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import type { DayPoint } from "../lib/api";
import { formatCompactNumber, formatDate } from "../lib/format";

const CHANNELS: Array<{ key: string; label: string; color: string }> = [
  { key: "organic", label: "SEO / organique", color: "var(--series-1)" },
  { key: "direct", label: "Direct", color: "var(--series-3)" },
  { key: "paid", label: "SEA / paid", color: "var(--series-2)" },
  { key: "referral", label: "Référent", color: "var(--series-7)" },
  { key: "social", label: "Social", color: "var(--series-5)" },
  { key: "email", label: "Email", color: "var(--series-4)" },
  { key: "other", label: "Autre", color: "var(--series-8)" },
];

export function ChannelMixChart({ data }: { data: DayPoint[] }) {
  const rows = data.map((d) => ({ date: d.date, ...d.channels }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
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
          labelFormatter={(d: string) => formatDate(d)}
          formatter={(value: number, name: string) => [formatCompactNumber(value), name]}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }} />
        {CHANNELS.map((c) => (
          <Area
            key={c.key}
            type="monotone"
            dataKey={c.key}
            name={c.label}
            stackId="channels"
            stroke={c.color}
            strokeWidth={1}
            fill={c.color}
            fillOpacity={0.65}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
