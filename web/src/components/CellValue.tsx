import { formatPct } from "../lib/format";

/**
 * Value + its own period-over-period delta, stacked inline in a table cell.
 * Reuses the same delta-up/delta-down/delta-flat semantics as KpiTile so a
 * red "-12%" in a table means the same thing as a red delta in a KPI tile.
 */
export function CellValue({
  value,
  deltaPct,
  deltaIsGoodWhenUp = true,
}: {
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
    <span className="cell-value">
      <span className="cell-value-main">{value}</span>
      {deltaPct !== null && <span className={`cell-value-delta ${deltaClass}`}>{formatPct(deltaPct)}</span>}
    </span>
  );
}
