import { formatPct } from "../lib/format";

export function KpiTile({
  label,
  value,
  deltaPct,
  deltaIsGoodWhenUp = true,
}: {
  label: string;
  value: string;
  deltaPct: number | null;
  deltaIsGoodWhenUp?: boolean;
}) {
  const deltaClass =
    deltaPct === null || Math.abs(deltaPct) < 0.001
      ? "delta-flat"
      : (deltaPct > 0) === deltaIsGoodWhenUp
      ? "delta-up"
      : "delta-down";

  return (
    <div className="kpi-tile">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className={`kpi-delta ${deltaClass}`}>{formatPct(deltaPct)} vs 7j précédents</div>
    </div>
  );
}
