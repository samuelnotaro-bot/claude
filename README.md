# Piwik Trends Analyzer

Application connectée à Piwik Pro pour suivre les tendances de **visibilité**, de
**captation de trafic** et de **conversions** sur les sites Socomec à extension
pays (+ hubs régionaux `emea.socomec.com` / `apac.socomec.com`), agrégées par
région business (**NAM / APAC / EMEA**), avec une synthèse périodique en 5-6
points orientée plan d'action.

- **Dashboard web** (React) : vue d'ensemble, détail par région business, détail
  par site, onglet Localisation, onglet Bots, historique des synthèses —
  sélecteur de période partagé sur tout le dashboard (préréglages 7/30/90/365
  jours **ou période personnalisée libre**), comparaison à la **période
  précédente** ou à **l'année précédente**.
- **KPIs SEO/GEO, signal bot et conversion** sur toutes les vues (global,
  région business, site) : trafic organique, trafic référé par des assistants
  IA, clics/impressions Search Console (intégration Piwik Pro), part de trafic
  à faible engagement (signal bot), demandes de devis/support, téléchargements
  — chacun avec une analyse et un début de plan d'action générés par un moteur
  de règles.
- **Job planifié** (Node/cron) : récupère les métriques Piwik Pro chaque jour et
  génère une synthèse hebdomadaire automatiquement ; un rattrapage au démarrage
  comble les jours manqués si le service s'est endormi pendant l'horaire prévu
  (voir « Fiabilité sur Render » plus bas).
- **Régions business fixes** : NAM/APAC/EMEA, définies par domaine (pas de
  géo-détection), surchargeables site par site si besoin.
- **Détection des pics de trafic anormal** : volume + concentration organique
  **ou directe** statistiquement hors norme (bots/crawlers non filtrés par
  Piwik Pro) — exclus des KPIs affichés aux directions, listés et quantifiés
  dans l'onglet Bots dédié.
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
  src/anomaly.ts    détection des pics de trafic anormal (organique ou direct, voir ci-dessous)
  src/bots.ts       agrège les pics détectés + quantifie le trafic bot vs. trafic total (onglet Bots)
  src/aiReferrers.ts liste des domaines d'assistants IA (classification du trafic référé par IA)
  src/period.ts     période libre + comparaison (période précédente / année précédente)
  src/cache.ts      cache TTL en mémoire pour les endpoints agrégés (performance)
  src/trends.ts     détection de tendances (WoW, z-score, mix de canaux, SEO/GEO, signal bot)
  src/synthesis.ts  génération des bullet points (règles, pas de LLM)
  src/scheduler.ts  cron: fetch quotidien + synthèse hebdomadaire
  src/sync.ts       fetch quotidien + rattrapage des jours manqués au démarrage
  src/basicAuth.ts  protection HTTP Basic de tout le dashboard
  src/staticWeb.ts  sert le build web (web/dist) depuis ce même serveur
  src/demoData.ts   générateur de données de démonstration
web/      Dashboard React (Vite) + Recharts
  src/lib/periodContext.tsx  période (préréglage ou libre) + mode de comparaison, partagés (contexte React)
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

## Détection des pics de trafic anormal, onglet Bots

`server/src/anomaly.ts` flague un jour comme anormal quand le volume de sessions
est statistiquement très au-dessus de la référence récente **et** que la part de
trafic organique **ou directe** est anormalement concentrée — signature observée
sur cette organisation Piwik Pro pour des vagues de bots/crawlers que le filtre
Piwik Pro natif ne détecte jamais (`visitor_type` reste à "Human" à 100%).

Ces jours sont exclus du calcul des KPIs affichés (`/api/overview`,
`/api/regions`, `/api/sites/summary`) mais restent visibles (point rouge) dans
les graphiques de détail par site/région, avec le nombre de jours exclus affiché
en petit sous les KPIs concernés.

L'onglet **Bots** dédié liste chaque variation détectée (site, date, canal
organique/direct, sessions vs. référence) et calcule une **estimation du
trafic bot** = somme des sessions en excès sur les jours flagués ÷ trafic total
mesuré sur la période. Un signal secondaire, plus doux, complète cette
estimation : la part de sessions "rebond" (1 page vue) sur les canaux
organique/direct, à lire comme une tendance plutôt qu'une quantification dure.

**Limite connue** : seuls les pics statistiquement extrêmes sont détectés — un
bruit de fond de trafic non-humain à un niveau plus faible, sous le seuil de
détection, reste inclus dans les KPIs et dans l'estimation du trafic bot (qui
est donc un plancher, pas une mesure exhaustive). La solution durable est de
vérifier le filtre anti-bot dans Piwik Pro (Administration > Confidentialité).

## Détection des écarts de géolocalisation (onglet Localisation)

Chaque site à extension pays a un pays attendu (déduit de son ccTLD, ex.
`socomec.co.uk` → GB). Un contrôle hebdomadaire (`geoMismatch.ts`, lancé avec
la synthèse périodique, ou à la demande via le bouton "Vérifier maintenant"
dans l'onglet **Localisation**) compare la répartition réelle des visiteurs par
pays (30 derniers jours) à ce pays attendu, et signale un site quand un seul
pays inattendu représente **au moins 20 %** du trafic (ex : trafic indien
important sur le site UK) — en dessous, l'écart est considéré trop marginal
pour justifier une analyse.

Pour chaque site signalé, le contrôle calcule aussi la répartition **organique
vs. directe** du trafic venant de ce pays inattendu (car les deux n'appellent
pas la même action) et génère un début d'analyse/plan d'action :
- **dominante organique** → piste SEO (hreflang/ccTLD mal ciblé, sitemap
  indexé sur le mauvais pays) ou vague de bots/crawlers classés à tort en
  organique — à croiser avec l'onglet Bots avant d'agir.
- **dominante directe** → probablement une audience réelle et légitime
  (diaspora, clients existants) — urgence faible, à confirmer avec l'équipe
  commerciale locale plutôt qu'une action corrective technique.

Les deux sites régionaux multi-pays (`emea.socomec.com`, `apac.socomec.com`)
suivent une règle plus large plutôt qu'un pays unique :
- `apac.socomec.com` : trafic attendu = Asie, hors Chine et Inde (qui ont déjà
  leur propre site pays).
- `emea.socomec.com` : trafic attendu = Europe / Afrique / Moyen-Orient, hors
  tout pays ayant déjà son propre site pays dédié.

**Limite connue** : classification géographique par regroupements de pays
volontairement simples (pas une source géopolitique faisant autorité), et
seuil fixe (20 %) plutôt qu'ajusté par site.

## Période libre et comparaison (période précédente / année précédente)

Le sélecteur de période partagé (`web/src/lib/periodContext.tsx`) propose les
préréglages habituels (7/30/90/365 jours) **ou** une période personnalisée
libre (deux sélecteurs de date), et un choix de comparaison : à la **période
précédente** (même durée, immédiatement avant) ou à **l'année précédente**
(mêmes dates, un an plus tôt). Tous les onglets (vue d'ensemble, régions,
sites) suivent cette sélection.

Le calcul de variation (`server/src/period.ts`) ne se fie plus au nombre de
lignes renvoyées par la base (fragile : un seul jour de synchronisation manqué
suffisait à faire disparaître la comparaison) mais à une série **complétée par
des zéros** sur toute la période demandée (`trends.zeroFillDayPoints`) combinée
à la date de la toute première donnée collectée : la comparaison n'est
affichée que si l'historique remonte réellement assez loin, pas si un jour
isolé manque.

## Fiabilité sur Render (démarrage et synchronisation)

Deux correctifs pour un déploiement fiable sur le plan gratuit de Render, qui
met le service en veille après une période d'inactivité :

- **Démarrage** : `server/start.sh` ne réinstalle/reconstruit (`npm install &&
  npm run build`) que si `node_modules`/`dist` sont réellement absents. Le
  `startCommand` de `render.yaml` ne force plus un rebuild à chaque démarrage
  du process — sur le plan gratuit, chaque réveil après mise en veille relance
  ce script dans le **même** système de fichiers (rien n'est effacé), donc un
  rebuild inconditionnel coûtait une minute ou plus à chaque réveil pour rien.
- **Données manquantes** : le fetch quotidien planifié (`FETCH_CRON`) ne peut
  se déclencher que si le process est éveillé à l'heure prévue — sur le plan
  gratuit, ce n'est pas garanti. `server/src/sync.ts#catchUpMissingDays`
  comble au démarrage les jours manquants entre la dernière synchronisation
  connue et hier (plafonné à 30 jours par réveil), pour que l'historique reste
  complet sans dépendre d'un réveil au bon moment.

## Limites connues / prochaines étapes possibles

- Pas de canal d'alerte (email/Slack) pour l'instant — la synthèse et les
  écarts de géolocalisation sont consultables dans le dashboard, à la demande
  de l'utilisateur.
