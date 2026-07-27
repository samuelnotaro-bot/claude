import { formatPct } from "../lib/format";

export function KpiTile({
  label,
  value,
  deltaPct,
  deltaIsGoodWhenUp = true,
  deltaLabel = "vs 7j précédents",
  note,
  noteTooltip,
}: {
  label: string;
  value: string;
  deltaPct: number | null;
  deltaIsGoodWhenUp?: boolean;
  /** Comparison text next to the delta, e.g. "vs 30j précédents". */
  deltaLabel?: string;
  /** Short caveat shown under the delta, e.g. "2 jours de pic trafic exclus". */
  note?: string;
  /** Longer explanation shown on hover/focus of the note. */
  noteTooltip?: string;
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
      <div className={`kpi-delta ${deltaClass}`}>{formatPct(deltaPct)} {deltaLabel}</div>
      {note && (
        <div className="kpi-note" title={noteTooltip} tabIndex={noteTooltip ? 0 : undefined}>
          {note}
        </div>
      )}
    </div>
  );
}
