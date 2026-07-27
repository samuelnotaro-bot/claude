# Piwik Trends Analyzer

Application connectée à Piwik Pro pour suivre les tendances de **visibilité**, de
**captation de trafic** et de **conversions** sur les sites Socomec à extension
pays (+ hubs régionaux `emea.socomec.com` / `apac.socomec.com`), agrégées par
région business (**NAM / APAC / EMEA**), avec une synthèse périodique en 5-6
points orientée plan d'action.

- **Dashboard web** (React) : vue d'ensemble, détail par région business, détail
  par site, historique des synthèses — sélecteur de période (7/30/90/365 jours)
  partagé sur tout le dashboard.
- **Job planifié** (Node/cron) : récupère les métriques Piwik Pro chaque jour et
  génère une synthèse hebdomadaire automatiquement.
- **Régions business fixes** : NAM/APAC/EMEA, définies par domaine (pas de
  géo-détection), surchargeables site par site si besoin.
- **Détection des pics de trafic anormal** : volume + concentration organique
  statistiquement hors norme (bots/crawlers non filtrés par Piwik Pro) — exclus
  des KPIs affichés aux directions, visibles dans le détail pour les analystes.
- **Synthèse sans risque de surcoût API** : générée par un moteur de règles
  statistiques local (variations semaine/semaine, z-score vs. historique,
  ruptures de mix de canaux) — aucun appel à une API LLM externe.
- **Protection d'accès** : authentification HTTP Basic (type "htaccess") devant
  tout le dashboard et l'API.

## Architecture

```
server/   API Node.js/TypeScript (Fastify) + PostgreSQL (pg)
  src/piwik/        client Piwik Pro (OAuth2 + Management API + Analytics Query API)
  src/continent.ts  régions business Socomec (NAM/APAC/EMEA) par nom de domaine
  src/siteScope.ts  filtre "extension pays" (quels sites Piwik Pro sont suivis)
  src/siteRegistry.ts découverte des sites + rattachement à une région
  src/anomaly.ts    détection des pics de trafic anormal (voir ci-dessous)
  src/trends.ts     détection de tendances (WoW, z-score, mix de canaux)
  src/synthesis.ts  génération des bullet points (règles, pas de LLM)
  src/scheduler.ts  cron: fetch quotidien + synthèse hebdomadaire
  src/basicAuth.ts  protection HTTP Basic de tout le dashboard
  src/staticWeb.ts  sert le build web (web/dist) depuis ce même serveur
  src/demoData.ts   générateur de données de démonstration
web/      Dashboard React (Vite) + Recharts
  src/lib/periodContext.tsx  sélecteur de période partagé (contexte React)
config/   site-overrides.json (rattachement manuel région, optionnel)
```

## Démarrage rapide (mode démo, sans identifiants Piwik Pro)

Nécessite une base **PostgreSQL** (locale ou distante, gratuite sur Render par
exemple) — voir `.env.example` pour le format de `DATABASE_URL`. Le schéma est
créé automatiquement au démarrage, aucune migration manuelle nécessaire.

```bash
npm install
cp .env.example .env      # renseigner au moins DATABASE_URL
npm run seed:demo        # génère les sites démo (dont un hors périmètre) + historique + 1re synthèse
npm run dev:server        # API sur http://localhost:4000
npm run dev:web            # Dashboard sur http://localhost:5173 (autre terminal)
```

Le mode démo (`PIWIK_MODE=demo`, valeur par défaut) simule les sites pays +
`emea`/`apac.socomec.com` répartis sur les 3 régions business, plus un site
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
   ceux dans le périmètre défini plus haut, rattache chacun à sa région business
   (NAM/APAC/EMEA, voir plus bas), puis importe l'historique et génère une
   première synthèse.
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

## Régions business (NAM / APAC / EMEA)

Chaque site est rattaché à une région business Socomec fixe, définie par nom de
domaine dans `server/src/continent.ts` (`businessRegionForSite`) :

- **NAM** : `socomec.us`
- **APAC** : `socomec.cn`, `socomec.co.in`, `apac.socomec.com`
- **EMEA** : tous les autres sites (catch-all)

Ce n'est pas une détection géographique du trafic — c'est la définition métier
de Socomec. Pour une exception ponctuelle, éditez `config/site-overrides.json` :

```json
{ "<id-du-site-piwik-pro>": "APAC" }
```

Cette valeur prime sur la règle par défaut.

## Synthèse périodique

Chaque semaine (configurable via `SYNTHESIS_CRON`), le moteur :
1. calcule les variations 7j/7j précédents pour le trafic, le taux de conversion
   et la répartition des canaux, par site, par région business et globalement ;
2. isole les écarts statistiquement significatifs (z-score vs. 8 semaines de
   référence) ;
3. classe les résultats par impact (ampleur du changement × volume concerné) ;
4. rédige 5-6 points d'action en français à partir des règles dans
   `server/src/synthesis.ts` — pas d'appel API, donc coût nul et 100% prévisible.

Le bouton **Générer maintenant** dans l'onglet Synthèses permet de relancer le
calcul à la demande.

## Détection des pics de trafic anormal

`server/src/anomaly.ts` flague un jour comme anormal quand le volume de sessions
est statistiquement très au-dessus de la référence récente **et** que la part de
trafic organique est anormalement concentrée — signature observée sur cette
organisation Piwik Pro pour des vagues de bots/crawlers que le filtre Piwik Pro
natif ne détecte jamais (`visitor_type` reste à "Human" à 100%).

Ces jours sont exclus du calcul des KPIs affichés (`/api/overview`,
`/api/regions`, `/api/sites/summary`) mais restent visibles (point rouge) dans
les graphiques de détail par site/région, avec le nombre de jours exclus affiché
en petit sous les KPIs concernés.

**Limite connue** : seuls les pics statistiquement extrêmes sont détectés — un
bruit de fond de trafic non-humain à un niveau plus faible, sous le seuil de
détection, reste inclus dans les KPIs. La solution durable est de vérifier le
filtre anti-bot dans Piwik Pro (Administration > Confidentialité).

## Détection des écarts de géolocalisation

Chaque site à extension pays a un pays attendu (déduit de son ccTLD, ex.
`socomec.co.uk` → GB). Un contrôle hebdomadaire (`geoMismatch.ts`, lancé avec
la synthèse périodique, ou à la demande via le bouton "Vérifier maintenant"
sur la vue d'ensemble) compare la répartition réelle des visiteurs par pays
(30 derniers jours) à ce pays attendu, et signale un site quand un seul pays
inattendu dépasse 15 % du trafic (ex : trafic indien important sur le site UK).

Les deux sites régionaux multi-pays (`emea.socomec.com`, `apac.socomec.com`)
suivent une règle plus large plutôt qu'un pays unique :
- `apac.socomec.com` : trafic attendu = Asie, hors Chine et Inde (qui ont déjà
  leur propre site pays).
- `emea.socomec.com` : trafic attendu = Europe / Afrique / Moyen-Orient, hors
  tout pays ayant déjà son propre site pays dédié.

**Limite connue** : classification géographique par regroupements de pays
volontairement simples (pas une source géopolitique faisant autorité), et
seuil fixe (15 %) plutôt qu'ajusté par site.

## Limites connues / prochaines étapes possibles

- Pas de canal d'alerte (email/Slack) pour l'instant — la synthèse et les
  écarts de géolocalisation sont consultables dans le dashboard, à la demande
  de l'utilisateur.
