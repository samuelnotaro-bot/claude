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

1. **Synthèse hebdomadaire persistée** (bas de l'onglet Synthèses,
   "Journal historique") : chaque semaine (configurable via
   `SYNTHESIS_CRON`), le moteur calcule les variations 7j/7j précédents,
   isole les écarts statistiquement significatifs (z-score vs. 8 semaines de
   référence), et enregistre 5-6 points d'action dans l'historique. Le
   bouton **Générer maintenant** relance ce calcul à la demande. Fenêtre
   fixe, indépendante du sélecteur de période -- conservée comme archive.
2. **Synthèse à la volée, cohérente avec la période sélectionnée** (haut de
   l'onglet Synthèses, endpoint dédié `/api/synthesis/period`) : recalculée
   à chaque changement de période/comparaison, à partir des mêmes KPIs
   affichés dans les autres onglets — pas de z-score/historique de 8
   semaines requis (une période personnalisée courte n'en a pas forcément),
   juste un seuil de variation relative par métrique. Contrairement à la
   carte "Synthèse — plan d'action" de la vue d'ensemble (qui ne classe que
   les findings à l'échelle globale), cette synthèse combine les findings de
   **tous les sites, toutes les régions et le global** pour la période, donc
   une chute localisée sur un seul site apparaît même si elle ne bouge pas
   le total agrégé. Elle intègre aussi, sans appel Piwik Pro supplémentaire :
   - le **signal bot** de la période (`computeBotSignal`, 100% local) ;
   - les **derniers résultats stockés** du contrôle de géolocalisation
     (avec leur horodatage `checkedAt` et leur plan d'action) --
     volontairement **pas** recalculés à la volée pour ne pas déclencher un
     appel Piwik Pro à chaque changement de période (voir "Fiabilité de la
     synchronisation" plus bas) ; relancez le contrôle depuis l'onglet
     Localisation pour une donnée à jour sur la période choisie.

Les deux utilisent le même texte d'action par métrique
(`bulletForFinding`), donc la voix reste cohérente entre le journal
hebdomadaire et l'analyse ad hoc.

## Détection des pics de trafic anormal, onglet Bots

`server/src/anomaly.ts` flague un jour comme "pic" par une règle unique et
simple, appliquée identiquement partout (points rouges sur les graphiques,
tableau Bots, compteurs KPI) : **sessions > 135% de la moyenne** des jours
comparés (soit plus de 35% au-dessus de la moyenne). Pas de z-score, pas de
signature de concentration par canal, pas d'exigence d'historique long --
volontairement le plus simple possible.

Un pic **n'est plus exclu des KPIs affichés** (`/api/overview`, `/api/regions`,
`/api/sites/summary`) : ces totaux doivent correspondre exactement à ceux de
Piwik Pro, donc rien n'en est retiré. Le jour reste inclus dans les sommes, et
seulement mis en évidence (point rouge sur les graphiques, compteur "Pics
détectés" dans les tableaux Sites/Régions, note informative sous les KPIs
concernés) pour que l'analyse business en tienne compte sans fausser les
chiffres.

Pour un agrégat région/global, la règle tourne sur le **total de la région/du
global elle-même**, pas sur une union des pics de chaque site : avec 15-20
sites, marquer l'agrégat "pic" dès qu'un seul site l'est ferait presque
toujours un faux positif (la probabilité qu'au moins un site sur 15-20 ait une
petite variation un jour donné approche 100%, même quand la région dans son
ensemble est parfaitement normale).

L'onglet **Bots** dédié applique cette même règle à deux échelles complémentaires :
- **vue globale** (`computeTrafficSpikes`) : jours où le trafic de l'ensemble
  des sites dépasse la moyenne globale de plus de 35%, avec la répartition
  organique/direct et les sites individuellement concernés ce jour-là ;
- **vue par site** (`flagAnomalies` appliqué site par site) : détecte un pic
  localisé à un seul site même quand le total global reste dans la norme.

Une **estimation du trafic bot** = somme des sessions en excès sur les jours
flagués ÷ trafic total mesuré sur la période, complétée par un signal
secondaire plus doux : la part de sessions "rebond" (1 page vue) sur les
canaux organique/direct.

**Limite connue** : la règle ne capte que les pics dépassant le seuil de 35% --
un bruit de fond de trafic non-humain à un niveau plus faible reste inclus
dans les KPIs et dans l'estimation du trafic bot (qui est donc un plancher,
pas une mesure exhaustive). La solution durable est de vérifier le filtre
anti-bot dans Piwik Pro (Administration > Confidentialité).

## Alerte de panne de données (0 stat sur plusieurs jours)

`server/src/trends.ts#detectDataOutages` détecte, pour chaque site, les séries
de **4 jours consécutifs ou plus** sans aucune donnée réelle -- que ce soit un
jour sans snapshot du tout (trou de synchronisation) ou un snapshot présent
mais à 0 session (tag de suivi cassé, intégration Piwik Pro interrompue) : les
deux ont la même conséquence pour qui lit le dashboard ("il ne s'est rien
passé ici"), et surtout la même conséquence dangereuse pour les comparaisons
de période : un total de comparaison anormalement bas ou nul explose la
variation en % calculée, même si le trafic réel n'a pas bougé.

Ces pannes sont signalées à deux endroits :
- un **bandeau visible** (`DataOutageBanner`, rouge, plus sévère que le
  bandeau jaune "données manquantes") sur la Vue d'ensemble, l'onglet Sites
  (site sélectionné), l'onglet Régions (région sélectionnée) et l'onglet
  Synthèses, indiquant le site, la région et la période exacte de la panne --
  aussi bien sur la période affichée que sur sa période de comparaison ;
- une **exclusion des tendances "bon signal"** : voir la section suivante.

Les pannes antérieures à la première donnée jamais synchronisée
(`earliestDataDate`) sont ignorées -- ce n'est pas une panne, juste l'absence
d'historique à cette date (déjà expliquée par le bandeau de comparaison
indisponible, voir "Transparence sur les données affichées").

## Variations extrêmes suspectes (>100%)

Une comparaison contre une période avec très peu de données réelles (panne
partielle, quelques jours seulement) produit un pourcentage de variation
techniquement calculable mais absurde -- un site à 50 sessions un jour puis
30000 sur la période affichée donnerait "+60000%" présenté comme un "bon
signal", alors que la vraie cause est presque toujours la période de
comparaison elle-même, pas un vrai changement métier.

`buildPeriodFindings` (`server/src/routes/api.ts`) traite toute variation
dépassant 100% comme suspecte (`Finding.suspect`) plutôt que comme une
tendance business confiante :
- le texte généré change de ton ("⚠ Donnée suspecte... à vérifier avant
  d'agir") et, quand une panne de données correspondante a été détectée sur
  la période de comparaison, la nomme explicitement (site, plage de dates) ;
- son poids dans le classement des tendances (`impactScore`) est réduit à
  quasi zéro, pour qu'une variation suspecte ne prenne jamais la place d'une
  vraie tendance dans le "Résumé" (top 6) de la synthèse -- elle reste
  visible dans la liste complète "Toutes les tendances notables", pas
  masquée, juste correctement priorisée.

Les chiffres bruts (tableaux, tuiles KPI) ne sont **jamais** modifiés ou
cachés par ce mécanisme -- seule la couche d'analyse/synthèse générée
applique ce garde-fou, pour ne jamais s'écarter des vrais chiffres Piwik Pro.

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

## Transparence sur les données affichées

Ce qui fait que les totaux affichés ne sont *pas* toujours une simple somme
brute des chiffres Piwik Pro est maintenant signalé directement sur les
métriques concernées plutôt que documenté seulement ici :

- **Jours de données manquantes** (`missingDays`) : les totaux
  **sous-estiment** les vrais chiffres Piwik Pro d'autant. Deux causes bien
  distinctes, affichées séparément dans le même bandeau plutôt que
  mélangées :
  - un vrai **trou de synchronisation** (voir "Fiabilité de la
    synchronisation" plus bas) -- pas voulu, mais **comblable** via le
    bouton "Combler les trous de données" ;
  - des jours **hors de la période de rétention Piwik Pro**
    (`missingDaysOutOfRetention`, voir `PIWIK_DATA_RETENTION_DAYS`
    ci-dessous) -- Piwik Pro n'a plus cette donnée nulle part, donc **aucun
    bouton ne peut jamais la récupérer**. Le message le dit explicitement
    ("ne seront jamais synchronisés") plutôt que de laisser espérer un
    comblement possible.
- **Métriques dérivées, pas natives Piwik Pro** : trafic référé par IA
  (reclassement par domaine référent, voir `aiReferrers.ts`), signal bot
  (proxy à partir des sessions rebond organique/direct), et la répartition
  devis/support (reclassement par mot-clé dans le nom de l'objectif, voir
  `goalCategories.ts`) n'existent pas sous cette forme dans l'interface Piwik
  Pro elle-même -- chaque tuile concernée porte la mention "(estimation)" et
  une note l'explique.

Par ailleurs, **votre compte Piwik Pro ne conserve pas plus de
`PIWIK_DATA_RETENTION_DAYS` jours d'historique** (791 jours par défaut, soit
26 mois -- ajustez selon votre contrat Piwik Pro réel) : toute comparaison
nécessitant de remonter plus loin que ça affiche "—" avec un message
explicite plutôt qu'un delta -- ce n'est pas une absence de variation, c'est
l'absence de donnée pour la comparer. Le bandeau distingue explicitement ce
cas (`retentionLimited`, impossible à combler) d'un simple trou de
synchronisation (`historyOk` faux mais comparaison théoriquement disponible
-- comblable via "Combler les trous de données"), pour ne jamais laisser
croire qu'un bouton peut résoudre une limite de rétention Piwik Pro.

**Important** : cette limite de 26 mois est celle de Piwik Pro, pas celle de
ce qui est actuellement stocké dans la base Postgres locale de l'app.
`BACKFILL_DAYS` (90 par défaut) ne récupère que les 90 derniers jours au
premier démarrage -- pour remonter plus loin (jusqu'aux 26 mois que Piwik Pro
conserve réellement), il faut soit augmenter `BACKFILL_DAYS`, soit relancer
un backfill ciblé sur une plage plus ancienne.

`npm run backfill` (et `backfillGaps`, "Combler les trous de données") ne font
plus une requête par site et par jour : `getMetricsRange`
(`server/src/piwik/client.ts`) regroupe chaque type de requête (totaux,
canaux, objectifs, ...) sur toute la plage de dates en un seul appel par site,
avec une dimension "jour" pour ventiler les résultats. Concrètement, un
backfill complet de 26 mois sur ~20 sites tient dans ~7 requêtes par site
(≈140 requêtes au total) au lieu d'environ 7 × 791 × 20 ≈ 110 000 -- largement
sous la limite de débit même sur l'historique complet.

Cette dimension "jour" (`COLUMN_IDS.dayDimension` + `DAY_DIMENSION_COLUMN`,
actuellement `{"column_id": "timestamp", "transformation_id": "to_date"}`,
d'après le forum communautaire Piwik Pro -- un premier essai avec
`"column_id": "date"` seul a échoué en direct contre l'organisation réelle :
`Dimension "date" does not exist.`) n'a toujours **pas** pu être vérifiée
noir sur blanc contre l'organisation Piwik Pro réelle (pas d'accès à un
compte de test pendant le développement) -- contrairement aux autres
`column_id` de ce fichier. `npm run test:connection` teste désormais ce mode
sur un site avant tout usage en masse et affiche clairement si ça fonctionne.
Si le `column_id` s'avère incorrect, chaque appel groupé échoue proprement et
retombe automatiquement sur l'ancien mode jour par jour pour les plages
courtes (≤14 jours) -- au-delà, l'échec remonte immédiatement avec le message
d'erreur réel plutôt que de retomber en silence sur des dizaines d'heures de
requêtes jour par jour. Jamais de données silencieusement fausses, dans le pire
cas juste pas de gain de vitesse.

`server/src/sync.ts#backfillGaps` applique la limite de rétention à son
scan : les jours manquants plus vieux que `PIWIK_DATA_RETENTION_DAYS` ne sont
**jamais** retentés (Piwik Pro ne les renverra plus) et sont comptés
séparément (`daysOutOfRetention`) plutôt que de gaspiller le budget d'appels
Piwik Pro limité sur des dates qui échoueraient indéfiniment.

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

### Écart trafic organique / clics Search Console

`checkOrganicSearchConsoleGap` (`server/src/routes/api.ts`) compare, pour
chaque site/région/global, le trafic organique Piwik Pro aux clics Search
Console de la même période : les deux devraient globalement se suivre
puisqu'ils représentent tous les deux du trafic Google Search. Un écart d'au
moins 4x dans un sens ou dans l'autre (site avec au moins 200 sessions
organiques et 50 clics GSC, sinon trop peu de volume pour être fiable) est
signalé comme finding avec une explication de départ différenciée selon le
sens :
- **organique très supérieur aux clics GSC** : trafic organique incluant
  d'autres sources que Google (Bing, IA génératives), vague de bots/crawlers
  classés à tort en organique (à croiser avec l'onglet Bots), ou délai de
  traitement propre à Search Console.
- **clics GSC très supérieurs à l'organique** : tracking Piwik Pro bloqué
  chez une partie des visiteurs (bloqueurs de pub, refus de consentement),
  rebond avant chargement du tag, ou un clic Search Console qui n'aboutit
  jamais à une session (page lente, erreur serveur).

**Limite connue** : le seuil de 4x est un point de départ raisonnable, pas un
étalonnage validé sur des données réelles -- à ajuster (constante
`ORGANIC_GSC_DISPARITY_RATIO`) si trop bruyant ou pas assez sensible en usage.

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

Piwik Pro applique aussi une limite d'appels API par minute, confirmée par la
doc officielle : **600/min pour les requêtes GET**, mais **60/min pour tout le
reste** (POST/PUT/PATCH/DELETE, y compris "les requêtes complexes en POST même
si elles ne font que lire" -- ce qui est exactement le fonctionnement de
l'Analytics Query API). Comme toutes les métriques de cette app passent par ce
endpoint POST, **60/min est la vraie limite qui s'applique** à quasiment tout
le trafic Piwik Pro de l'app -- ce n'est pas une estimation prudente.
`server/src/piwik/client.ts` fait passer **tous** les appels par un limiteur à
fenêtre glissante (`PIWIK_MAX_REQUESTS_PER_MINUTE`, défaut 60/min) au même
point de passage que chaque requête HTTP, et gère les réponses 429 (respecte
`Retry-After`, jusqu'à 3 tentatives) avant d'abandonner proprement -- géré par
la résilience par item ci-dessus, donc un item qui échoue vraiment est
retenté au prochain passage plutôt que de bloquer le reste. `geoMismatch.ts` a
aussi été réduit à une seule requête Piwik Pro par site (au lieu de deux) en
dérivant les totaux par pays de la répartition par canal déjà récupérée.

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
  l'historique existant (pas seulement la queue), à l'exclusion des jours
  plus vieux que `PIWIK_DATA_RETENTION_DAYS` (voir "Transparence sur les
  données affichées" plus haut -- ceux-là ne seront jamais renvoyés par
  Piwik Pro), pour trouver les couples (site, jour) manquants et les
  recharge, plafonné à 25 par exécution pour éviter une rafale d'appels API
  après une très longue absence — le reste se comble à l'exécution suivante
  (prochain réveil, ou immédiatement via le
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
