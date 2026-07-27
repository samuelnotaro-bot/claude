# Piwik Trends Analyzer

Application connectée à Piwik Pro pour suivre les tendances de **visibilité**, de
**captation de trafic** et de **conversions** sur 22 sites, agrégées par continent,
avec une synthèse périodique en 5-6 points orientée plan d'action.

- **Dashboard web** (React) : vue d'ensemble, détail par continent, détail des 22
  sites, historique des synthèses.
- **Job planifié** (Node/cron) : récupère les métriques Piwik Pro chaque jour et
  génère une synthèse hebdomadaire automatiquement.
- **Détection automatique des continents** : chaque site est rattaché au continent
  du pays d'où provient la majorité de son trafic (surchargeable manuellement).
- **Synthèse sans risque de surcoût API** : générée par un moteur de règles
  statistiques local (variations semaine/semaine, z-score vs. historique,
  ruptures de mix de canaux) — aucun appel à une API LLM externe.

## Architecture

```
server/   API Node.js/TypeScript (Fastify) + SQLite (better-sqlite3)
  src/piwik/        client Piwik Pro (OAuth2 + Management API + Analytics Query API)
  src/continent.ts  mapping pays -> continent
  src/siteRegistry.ts découverte des sites + détection de continent
  src/trends.ts     détection de tendances/anomalies (WoW, z-score, mix de canaux)
  src/synthesis.ts  génération des bullet points (règles, pas de LLM)
  src/scheduler.ts  cron: fetch quotidien + synthèse hebdomadaire
  src/demoData.ts   générateur de données de démonstration
web/      Dashboard React (Vite) + Recharts
config/   site-overrides.json (rattachement manuel continent, optionnel)
```

## Démarrage rapide (mode démo, sans identifiants Piwik Pro)

```bash
npm install
npm run seed:demo        # génère 22 sites démo + 90 jours d'historique + 1re synthèse
npm run dev:server        # API sur http://localhost:4000
npm run dev:web            # Dashboard sur http://localhost:5173 (autre terminal)
```

Le mode démo (`PIWIK_MODE=demo`, valeur par défaut) simule 22 sites répartis sur
6 continents avec des schémas de tendances réalistes (chute de trafic, recul de
conversion, bascule SEO→SEA) pour que le moteur d'analyse ait quelque chose de
concret à détecter dès le premier lancement.

## Passer en production avec votre Piwik Pro

1. Dans Piwik Pro : **Administration > Custom access clients**, créez un client
   OAuth2 avec un accès en lecture (Analytics + Apps) sur vos 22 sites.
2. Copiez `.env.example` vers `.env` et renseignez :
   ```
   PIWIK_MODE=live
   PIWIK_BASE_URL=https://votre-org.piwik.pro
   PIWIK_CLIENT_ID=...
   PIWIK_CLIENT_SECRET=...
   ```
3. `npm run backfill` — découvre vos 22 sites via l'API Management, détecte
   automatiquement le continent de chacun (pays dominant du trafic sur 90 jours),
   puis importe l'historique et génère une première synthèse.
4. `npm run dev:server` (ou `npm run build && node server/dist/index.js` en
   production) démarre l'API **et** le planificateur (fetch quotidien + synthèse
   hebdomadaire, horaires réglables via `FETCH_CRON` / `SYNTHESIS_CRON`).

> Les identifiants de champ (`COLUMN_IDS` dans `server/src/piwik/client.ts`)
> suivent la documentation publique de l'API Piwik Pro (developers.piwik.pro).
> Piwik Pro fait parfois évoluer les identifiants de colonnes entre versions —
> si `npm run backfill` renvoie des métriques à zéro en mode live, vérifiez les
> noms de colonnes dans l'API Explorer de votre organisation et ajustez ce fichier.

## Rattachement manuel d'un continent

Si le trafic dominant d'un site ne reflète pas correctement son marché cible
(ex : un site "global" en anglais), éditez `config/site-overrides.json` :

```json
{ "<id-du-site-piwik-pro>": "Europe" }
```

Cette valeur prime sur la détection automatique.

## Synthèse périodique

Chaque semaine (configurable via `SYNTHESIS_CRON`), le moteur :
1. calcule les variations 7j/7j précédents pour le trafic, le taux de conversion
   et la répartition des canaux, par site, par continent et globalement ;
2. isole les écarts statistiquement significatifs (z-score vs. 8 semaines de
   référence) ;
3. classe les résultats par impact (ampleur du changement × volume concerné) ;
4. rédige 5-6 points d'action en français à partir des règles dans
   `server/src/synthesis.ts` — pas d'appel API, donc coût nul et 100% prévisible.

Le bouton **Générer maintenant** dans l'onglet Synthèses permet de relancer le
calcul à la demande.

## Limites connues / prochaines étapes possibles

- Pas de canal d'alerte (email/Slack) pour l'instant — la synthèse est
  consultable dans le dashboard, à la demande de l'utilisateur.
- Le mapping colonnes de l'API Piwik Pro (`COLUMN_IDS`) n'a pas pu être testé
  contre un vrai compte (pas d'identifiants disponibles pendant le
  développement) — à vérifier lors du premier `backfill` en mode `live`.
