interface HistoryWarningProps {
  historyOk: boolean;
  retentionLimited: boolean;
  comparisonFrom: string;
  earliestDataDate: string | null;
  retentionFloorDate: string;
}

/**
 * Explains why a period-over-period comparison is unavailable, distinguishing
 * two causes that need very different reactions from the user:
 * - retention-limited: Piwik Pro itself no longer has the data (nothing to
 *   fix, ever -- pick a shorter comparison window instead).
 * - sync gap: we have simply not synced that far back yet (fixable via
 *   "Combler les trous de données").
 */
export function HistoryWarningBanner({ historyOk, retentionLimited, comparisonFrom, earliestDataDate, retentionFloorDate }: HistoryWarningProps) {
  if (historyOk) return null;

  if (retentionLimited) {
    return (
      <p className="data-quality-banner">
        ⚠ Comparaison impossible pour cette sélection : il faudrait remonter au {comparisonFrom}, mais Piwik Pro ne
        conserve les données qu'à partir du {retentionFloorDate} sur ce compte (rétention) -- au-delà, la donnée
        n'existe plus nulle part, y compris dans Piwik Pro lui-même. Ce n'est pas un trou de synchronisation
        comblable : choisissez une période plus courte, ou comparez "à la période précédente" plutôt qu'"à l'année
        précédente".
      </p>
    );
  }

  return (
    <p className="data-quality-banner">
      ⚠ Comparaison indisponible pour cette sélection : il faudrait un historique remontant au {comparisonFrom}, mais
      les données synchronisées commencent seulement le {earliestDataDate ?? "?"}. C'est un trou de synchronisation
      comblable (pas une limite Piwik Pro) -- utilisez "Combler les trous de données" sur la Vue d'ensemble, ou
      choisissez une période plus courte en attendant.
    </p>
  );
}
