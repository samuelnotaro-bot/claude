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
  src/bots.ts       variations statistiques + liste souple de pics de trafic + estimation du trafic bot (onglet Bots)
  src/aiReferrers.ts liste des domaines d'assistants IA (classification du trafic référé par IA)
  src/period.ts     période libre + comparaison (période précédente / année précédente)
  src/cache.ts      cache TTL en mémoire pour les endpoints agrégés (performance)
  src/trends.ts     agrégation nullable-safe + détection de tendances (WoW, z-score, mix de canaux, SEO/GEO, signal bot)
  src/synthesis.ts  génération des bullet points (règles, pas de LLM), réutilisé pour la synthèse hebdo et la synthèse à la volée
  src/scheduler.ts  cron: fetch quotidien + synthèse hebdomadaire
  src/sync.ts       fetch quotidien + scan/comblement des trous dans l'historique (pas seulement en fin de période)
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

## Synthèse

Deux mécanismes distincts partagent le même moteur de règles
(`server/src/synthesis.ts`, aucun appel API donc coût nul et 100% prévisible) :

1. **Synthèse hebdomadaire persistée** (onglet Synthèses) : chaque semaine
   (configurable via `SYNTHESIS_CRON`), le moteur calcule les variations
   7j/7j précédents, isole les écarts statistiquement significatifs (z-score
   vs. 8 semaines de référence), et enregistre 5-6 points d'action dans
   l'historique. Le bouton **Générer maintenant** relance ce calcul à la
   demande.
2. **Synthèse à la volée, cohérente avec la période sélectionnée** (carte
   "Synthèse — plan d'action" sur la vue d'ensemble) : recalculée à chaque
   changement de période/comparaison directement dans `/api/overview`, à
   partir des mêmes KPIs affichés juste au-dessus — pas de z-score/historique
   de 8 semaines requis (une période personnalisée courte n'en a pas
   forcément), juste un seuil de variation relative par métrique. Les
   panneaux "Analyse & plan d'action" des onglets Régions et Sites suivent le
   même principe, scopés à la région/au site sélectionné.

Les deux utilisent le même texte d'action par métrique
(`bulletForFinding`), donc la voix reste cohérente entre le journal
hebdomadaire et l'analyse ad hoc.

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

Cette détection statistique stricte nécessite 14 à 56 jours d'historique et une
signature précise (concentration par canal) : sur un historique court, ou pour
un pic qui ne colle pas exactement à cette signature, elle ne renvoie rien.
L'onglet affiche donc en complément une liste **"Pics de trafic"** plus souple
(`server/src/bots.ts#computeTrafficSpikes`) : les jours où le trafic (tous
sites) dépasse notablement la moyenne de la période sélectionnée, avec la
répartition organique/direct et les sites dont la propre moyenne est elle
aussi dépassée ce jour-là ("sites concernés") — utile dès quelques jours de
données, sans attendre 8 semaines d'historique.

**Limite connue** : la détection statistique stricte ne capte que les pics
statistiquement extrêmes — un bruit de fond de trafic non-humain à un niveau
plus faible, sous le seuil de détection, reste inclus dans les KPIs et dans
l'estimation du trafic bot (qui est donc un plancher, pas une mesure
exhaustive). La solution durable est de vérifier le filtre anti-bot dans
Piwik Pro (Administration > Confidentialité).

## Détection des écarts de géolocalisation (onglet Localisation)

Chaque site à extension pays a un pays attendu (déduit de son ccTLD, ex.
`socomec.co.uk` → GB). Un contrôle hebdomadaire (`geoMismatch.ts`, lancé avec
la synthèse périodique sur les 30 derniers jours) compare la répartition
réelle des visiteurs par pays à ce pays attendu, et signale un site quand un
seul pays inattendu représente **au moins 20 %** du trafic (ex : trafic
indien important sur le site UK) — en dessous, l'écart est considéré trop
marginal pour justifier une analyse. Dans l'onglet **Localisation**, ce
contrôle se relance automatiquement sur la **période actuellement
sélectionnée** (bouton "Vérifier maintenant" pour le relancer à la demande
sans changer de période), pour rester cohérent avec le reste du dashboard.

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

Chaque onglet a sa propre URL (`#/overview`, `#/regions`, `#/sites`,
`#/localisation`, `#/bots`, `#/synthesis`) pour un partage direct d'un lien
vers un onglet précis -- pas la période sélectionnée pour l'instant, qui
reste un état local du navigateur.

Le calcul de variation (`server/src/period.ts`) ne se fie plus au nombre de
lignes renvoyées par la base (fragile : un seul jour de synchronisation manqué
suffisait à faire disparaître la comparaison) mais à une série **complétée par
des zéros** sur toute la période demandée (`trends.zeroFillDayPoints`) combinée
à la date de la toute première donnée collectée : la comparaison n'est
affichée que si l'historique remonte réellement assez loin, pas si un jour
isolé manque.

## Explication des variations ("pourquoi ce chiffre a bougé")

Pour une variation significative au niveau global ou d'une région business
(ex. "taux de conversion en baisse de 12%"), `explainFinding`
(`server/src/routes/api.ts`) identifie les sites qui y contribuent le plus :
pour une métrique de type taux (taux de conversion, signal bot), les sites
sont classés par leur propre variation en points ; pour une métrique de
volume (sessions, conversions, devis, ...), par leur propre variation en
valeur absolue, dans la même unité que l'agrégat. Les sites en dessous de 200
sessions sur la période sont ignorés (trop peu de volume pour être une
explication fiable). Le résultat s'affiche comme sous-ligne sous le
constat ("Principal(aux) contributeur(s) : socomec.de (-2.6 pt, -72%), ...")
dans les panneaux "Analyse & plan d'action" (vue d'ensemble et régions).

**Limite connue** : décomposition à un seul niveau (site le plus contributeur),
pas une analyse causale complète -- ça répond à "quel site" plutôt qu'à
"quelle action précise sur ce site l'explique" (à investiguer manuellement à
partir du site nommé).

## Fiabilité de la synchronisation (résilience aux erreurs Piwik Pro)

Avant ce correctif, une seule erreur API transitoire (limite de débit,
coupure réseau, un site mal configuré) sur un site suffisait à interrompre
**tout le reste** du lot en cours (`Promise.all` rejette dès le premier
échec) -- sur ~20 sites, ça voulait dire que les sites suivants dans le lot
n'étaient jamais synchronisés ce jour-là, silencieusement. C'est la cause la
plus probable de trous récurrents malgré le rattrapage. `server/src/sync.ts`
isole maintenant chaque couple (site, jour) : un échec est loggé et
comptabilisé (`daysFailed` dans la réponse de `POST /api/data/fill-gaps`,
visible dans le message affiché par le bouton "Combler les trous de
données") mais n'empêche plus les autres sites/jours du même lot d'être
traités.

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
  gratuit, ce n'est pas garanti, et une erreur API transitoire peut aussi
  faire échouer un seul site un seul jour. Résultat concret observé : des
  trous *à l'intérieur* de l'historique (ex. "pas de données du 1er au 19
  juillet"), pas seulement à la fin, ce qui rendait aussi les comparaisons de
  période peu fiables. `server/src/sync.ts#backfillGaps` scanne tout
  l'historique existant (pas seulement la queue) pour trouver les couples
  (site, jour) manquants et les recharge, plafonné à 300 par exécution pour
  éviter une rafale d'appels API après une très longue absence — le reste se
  comble à l'exécution suivante (prochain réveil, ou immédiatement via le
  bouton **Combler les trous de données** sur la vue d'ensemble, qui appelle
  `POST /api/data/fill-gaps`).

## Fiabilité des KPIs optionnels (IA/Search Console/signal bot)

Trois KPIs (trafic référé par IA, clics/impressions Search Console, signal
bot organique/direct) dépendent chacun d'une requête Piwik Pro distincte des
métriques de base, qui peut échouer indépendamment (colonne non supportée par
cette organisation, intégration Search Console non configurée sur un site,
erreur API transitoire). Une requête en échec est stockée en base comme
`NULL`, pas comme `0` : le dashboard affiche alors **"non disponible"** au
lieu d'un zéro trompeur, et l'agrégation (site → région → global) ne renvoie
un total `null` que si *toutes* les valeurs contributives sont indisponibles
— une seule donnée réelle suffit à produire un total partiel plutôt que rien.

Pour diagnostiquer un "non disponible" persistant sans fouiller les logs
Render, `GET /api/diagnostics/optional-metrics` (uniquement en
`PIWIK_MODE=live`) relance les 3 requêtes pour un site réel et renvoie le
message d'erreur exact de chacune.

**Limite connue** : les lignes écrites avant ce correctif restent à `0` en
base (impossible de savoir rétroactivement lesquelles étaient un vrai zéro
plutôt qu'un échec passé) — seules les nouvelles écritures (sync quotidien,
rattrapage) bénéficient de la distinction `null`/`0`.

## Limites connues / prochaines étapes possibles

- Pas de canal d'alerte (email/Slack) pour l'instant — la synthèse et les
  écarts de géolocalisation sont consultables dans le dashboard, à la demande
  de l'utilisateur.
