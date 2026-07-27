# Piwik Trends Analyzer

Application connectée à Piwik Pro pour suivre les tendances de **visibilité**, de
**captation de trafic** et de **conversions** sur les sites Socomec à extension
pays (+ hubs régionaux `emea.socomec.com` / `apac.socomec.com`), agrégées par
continent, avec une synthèse périodique en 5-6 points orientée plan d'action.

- **Dashboard web** (React) : vue d'ensemble, détail par continent, détail par
  site, historique des synthèses.
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
npm run seed:demo        # génère les sites démo (dont un hors périmètre) + 90 jours d'historique + 1re synthèse
npm run dev:server        # API sur http://localhost:4000
npm run dev:web            # Dashboard sur http://localhost:5173 (autre terminal)
```

Le mode démo (`PIWIK_MODE=demo`, valeur par défaut) simule les sites pays +
`emea`/`apac.socomec.com` répartis sur 6 continents, plus un site
`shop.socomec.com` volontairement hors périmètre pour illustrer le filtrage
(voir « Périmètre des sites suivis » ci-dessous), avec des schémas de tendances
réalistes (chute de trafic, recul de conversion, bascule SEO→SEA) pour que le
moteur d'analyse ait quelque chose de concret à détecter dès le premier
lancement.

## Périmètre des sites suivis

L'application ne retient que les sites Piwik Pro sur une **extension de domaine
pays** (ccTLD), ex. `socomec.fr`, `socomec.co.uk`, `socomec.com.br`. Le domaine
générique `socomec.com` est exclu, à l'exception explicite de deux sous-domaines
régionaux : `emea.socomec.com` et `apac.socomec.com`. Tout autre sous-domaine de
`socomec.com` (apex, `www`, `shop`, `blog`, ...) est ignoré.

Cette règle est appliquée par `server/src/siteScope.ts` (`isAppInScope`) lors de
chaque découverte de sites (`syncSiteRegistry`) : les sites hors périmètre ne
sont jamais importés, et un site précédemment synchronisé qui sort du périmètre
(changement de config) est automatiquement retiré de la base au prochain sync.

## Tester la connexion Piwik Pro

```bash
npm run test:connection
```

Nécessite `PIWIK_MODE=live` et les identifiants OAuth2 dans `.env`. La commande
authentifie le client, liste les sites visibles par l'API Management, puis
affiche lesquels sont dans le périmètre et lesquels sont ignorés — utile pour
vérifier les identifiants et la règle de filtrage avant de lancer un
`backfill` complet.

## Passer en production avec votre Piwik Pro

1. Dans Piwik Pro : **Administration > Custom access clients**, créez un client
   OAuth2 avec un accès en lecture (Analytics + Apps) sur vos sites.
2. Copiez `.env.example` vers `.env` et renseignez :
   ```
   PIWIK_MODE=live
   PIWIK_BASE_URL=https://votre-org.piwik.pro
   PIWIK_CLIENT_ID=...
   PIWIK_CLIENT_SECRET=...
   ```
3. `npm run test:connection` — vérifie l'authentification et affiche le détail
   du filtrage (voir ci-dessus) sans toucher à la base de données.
4. `npm run backfill` — découvre vos sites via l'API Management, ne retient que
   ceux dans le périmètre défini plus haut, détecte automatiquement le
   continent de chacun (pays dominant du trafic sur 90 jours), puis importe
   l'historique et génère une première synthèse.
5. `npm run dev:server` (ou `npm run build && node server/dist/index.js` en
   production) démarre l'API **et** le planificateur (fetch quotidien + synthèse
   hebdomadaire, horaires réglables via `FETCH_CRON` / `SYNTHESIS_CRON`).

> Les identifiants de colonnes (`COLUMN_IDS` dans `server/src/piwik/client.ts`)
> ont été vérifiés contre l'organisation Piwik Pro réelle : `sessions`,
> `visitors`, `page_views`, `goal_conversions`, `bounce_rate`, dimension pays
> `location_country_name` (renvoie un tuple `[code_iso, nom]`), dimension canal
> `medium`. La durée moyenne de session (`avgSessionDurationSec`) reste à 0 :
> aucun `column_id` valide n'a été trouvé après une recherche exhaustive — à
> confirmer auprès du support Piwik Pro ou de l'API Explorer si cette métrique
> est nécessaire.

## Rattachement manuel d'un continent

Si le trafic dominant d'un site ne reflète pas correctement son marché cible
(ex : un site "global" en anglais), éditez `config/site-overrides.json` :

```json
{ "<id-du-site-piwik-pro>": "Europe" }
```

Cette valeur prime sur la détection automatique. `config/site-overrides.json`
contient déjà un exemple pour les deux hubs régionaux du mode démo
(`site-emea` → Europe, `site-apac` → Asia) ; en mode live, remplacez ces clés
par les vrais UUID Piwik Pro de `emea.socomec.com` et `apac.socomec.com`.

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
