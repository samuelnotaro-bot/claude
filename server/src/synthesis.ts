import type { Finding } from "./trends.js";

/**
 * Deterministic, rule-based synthesis generator: turns ranked statistical findings
 * into a short, action-oriented briefing (5-6 bullets). No external/LLM API calls,
 * so there is zero risk of API usage cost -- everything runs locally from the
 * numbers already computed by trends.ts.
 */

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}

function pts(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)} pts`;
}

const CHANNEL_LABELS: Record<string, string> = {
  organic: "SEO / organique",
  direct: "trafic direct",
  referral: "référent",
  paid: "SEA / paid",
  social: "social",
  email: "email",
  other: "autre",
};

function scopeLabel(f: Finding): string {
  if (f.scope === "global") return "l'ensemble des sites";
  if (f.scope === "continent") return f.entityName;
  return f.entityName;
}

function bulletForFinding(f: Finding, siblingSessionsFinding?: Finding): string {
  const who = scopeLabel(f);

  // A change this extreme is a data-quality artifact until proven otherwise
  // (see routes/api.ts#buildPeriodFindings) -- never phrase it as a confident
  // "bon signal" or "à corriger d'urgence" business trend.
  if (f.suspect) {
    return `⚠ Donnée suspecte sur ${who} — ${f.label} : ${f.explanation ?? "variation extrême à vérifier avant d'agir, probablement causée par une période de comparaison incomplète."}`;
  }

  if (f.metric === "sessions") {
    if (f.direction === "down") {
      return `Trafic en baisse sur ${who} : ${pct(f.changePct ?? 0)} sur la période (${Math.round(f.current)} sessions) → auditer en priorité le SEO (indexation, positions), les changements techniques récents et la disponibilité du site.`;
    }
    return `Trafic en hausse sur ${who} : ${pct(f.changePct ?? 0)} sur la période (${Math.round(f.current)} sessions) → identifier le levier gagnant (campagne, contenu, saisonnalité) et le répliquer sur des sites comparables.`;
  }

  if (f.metric === "conversionRate") {
    const trafficNote = siblingSessionsFinding
      ? siblingSessionsFinding.direction === "down"
        ? " (le trafic recule aussi, effet cumulatif)"
        : " alors que le trafic est stable ou en hausse"
      : "";
    if (f.direction === "down") {
      return `Taux de conversion en recul sur ${who} : ${pct(f.changePct ?? 0)}${trafficNote} → auditer le tunnel d'achat (mobile en priorité), vérifier un bug de paiement ou un changement UX récent. Action prioritaire : test utilisateur du parcours de conversion.`;
    }
    return `Taux de conversion en hausse sur ${who} : ${pct(f.changePct ?? 0)}${trafficNote} → documenter et répliquer le changement (offre, UX, campagne) sur les autres sites de la même région.`;
  }

  if (f.metric === "goalConversions") {
    if (f.direction === "down") {
      return `Volume de conversions en baisse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → vérifier si la cause est le trafic ou le taux de conversion, et prioriser l'audit du tunnel si le trafic est stable.`;
    }
    return `Volume de conversions en hausse sur ${who} : ${pct(f.changePct ?? 0)} sur la période, bon signal à consolider (retargeting, fidélisation).`;
  }

  if (f.metric === "organicSessions") {
    if (f.direction === "down") {
      return `Trafic organique en baisse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → vérifier Search Console (couverture, positions), les modifications techniques récentes (robots.txt, redirections) et une éventuelle pénalité algorithmique.`;
    }
    return `Trafic organique en hausse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → identifier les pages/mots-clés moteurs de cette croissance et capitaliser dessus (contenu associé, maillage interne).`;
  }

  if (f.metric === "aiReferralSessions") {
    if (f.direction === "down") {
      return `Trafic référé par des assistants IA en baisse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → signal faible, à surveiller sans action immédiate.`;
    }
    return `Trafic référé par des assistants IA en hausse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → vérifier que le contenu cité par ces assistants est à jour et correctement structuré (GEO : réponses claires, données structurées).`;
  }

  if (f.metric === "lowEngagementShare") {
    if (f.direction === "up") {
      return `Part de trafic à faible engagement (organique/direct, signal bot) en hausse sur ${who} : ${pts(f.changePct ?? 0)} → croiser avec l'onglet Bots pour confirmer une vague de trafic non-humain avant de tirer une conclusion business sur le trafic/la conversion.`;
    }
    return `Part de trafic à faible engagement (signal bot) en baisse sur ${who} : ${pts(f.changePct ?? 0)}, bon signal de qualité de trafic.`;
  }

  if (f.metric === "rfq") {
    if (f.direction === "down") {
      return `Demandes de devis en baisse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → vérifier le tunnel de demande de devis (formulaire, disponibilité) et si la baisse suit celle du trafic.`;
    }
    return `Demandes de devis en hausse sur ${who} : ${pct(f.changePct ?? 0)} sur la période, bon signal commercial à transmettre aux ventes.`;
  }

  if (f.metric === "support") {
    if (f.direction === "up") {
      return `Demandes de support en hausse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → vérifier s'il y a un problème produit/site en cours qui génère ce surcroît de demandes.`;
    }
    return `Demandes de support en baisse sur ${who} : ${pct(f.changePct ?? 0)} sur la période.`;
  }

  if (f.metric === "downloads") {
    if (f.direction === "down") {
      return `Téléchargements en baisse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → vérifier l'accessibilité du centre de ressources (liens cassés, changement récent).`;
    }
    return `Téléchargements en hausse sur ${who} : ${pct(f.changePct ?? 0)} sur la période, bon signal d'intérêt pour la documentation produit.`;
  }

  if (f.metric === "searchConsoleClicks") {
    if (f.direction === "down") {
      return `Clics Search Console en baisse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → vérifier les positions moyennes et le taux de clic (CTR) par requête dans Search Console.`;
    }
    return `Clics Search Console en hausse sur ${who} : ${pct(f.changePct ?? 0)} sur la période → bon signal SEO, identifier les requêtes/pages en tête de la croissance.`;
  }

  if (f.metric === "organicSearchConsoleGap") {
    return `Écart organique / Search Console sur ${who} : ${f.explanation ?? "écart important entre trafic organique et clics Search Console, à investiguer."}`;
  }

  // channelMix
  const channel = CHANNEL_LABELS[f.detail ?? "other"] ?? f.detail ?? "un canal";
  if (f.direction === "up") {
    const action =
      f.detail === "paid"
        ? "vérifier le ROI et le budget SEA engagé (dépendance croissante au paid)."
        : "capitaliser sur ce canal en renforçant les investissements associés.";
    return `Recomposition des canaux d'acquisition sur ${who} : part du ${channel} en hausse de ${pts(f.changePct ?? 0)} sur la période → ${action}`;
  }
  const action =
    f.detail === "organic"
      ? "auditer le référencement naturel (positions, backlinks, Core Web Vitals) avant que la perte ne s'aggrave."
      : "identifier la cause de la baisse de ce canal et réallouer le budget si nécessaire.";
  return `Recomposition des canaux d'acquisition sur ${who} : part du ${channel} en baisse de ${pts(f.changePct ?? 0)} sur la période → ${action}`;
}

export interface SynthesisResult {
  bullets: string[];
  highlights: Record<string, unknown>;
}

export function generateSynthesis(
  findings: Finding[],
  globalOverview: { totalSessions: number; prevTotalSessions: number; conversionRate: number; prevConversionRate: number }
): SynthesisResult {
  const overviewChangePct =
    globalOverview.prevTotalSessions === 0 ? 0 : (globalOverview.totalSessions - globalOverview.prevTotalSessions) / globalOverview.prevTotalSessions;
  const convChangePct =
    globalOverview.prevConversionRate === 0 ? 0 : (globalOverview.conversionRate - globalOverview.prevConversionRate) / globalOverview.prevConversionRate;

  const bullets: string[] = [];
  bullets.push(
    `Vue d'ensemble : ${Math.round(globalOverview.totalSessions)} sessions sur la période (${pct(overviewChangePct)} vs la période précédente), taux de conversion global ${(globalOverview.conversionRate * 100).toFixed(2)}% (${pct(convChangePct)}).`
  );

  const sessionsBySite = new Map(findings.filter((f) => f.metric === "sessions").map((f) => [f.entityId, f]));
  const ranked = [...findings].sort((a, b) => b.impactScore - a.impactScore);

  const seen = new Set<string>();
  for (const f of ranked) {
    if (bullets.length >= 6) break;
    const key = `${f.scope}:${f.entityId}:${f.metric}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(bulletForFinding(f, f.metric === "conversionRate" ? sessionsBySite.get(f.entityId) : undefined));
  }

  if (bullets.length < 5) {
    bullets.push(
      "Aucune anomalie majeure supplémentaire détectée récemment sur les sites et régions suivis → poursuivre la surveillance régulière, aucune action corrective urgente au-delà des points ci-dessus."
    );
  }

  return {
    bullets: bullets.slice(0, 6),
    highlights: {
      totalSessions: globalOverview.totalSessions,
      overviewChangePct,
      conversionRate: globalOverview.conversionRate,
      convChangePct,
      findingsCount: findings.length,
    },
  };
}
