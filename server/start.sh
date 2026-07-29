#!/bin/sh
# Whatever Render's dashboard Build/Start Command actually is (they don't
# necessarily match render.yaml -- confirmed in practice: the Build Command
# doesn't always run at all, leaving node_modules missing entirely, on top of
# dist/ being stripped from the build artifact since it's gitignored), this
# script makes startup self-healing as long as it's reached at all: install
# dependencies if missing, then rebuild from source if dist/index.js or the
# web build isn't there, before starting -- instead of depending on Render's
# dashboard settings being correctly configured.
#
# IMPORTANT: this check must stay cheap and skip the rebuild whenever the
# previous build is already on disk AND still matches the checked-out source.
# On Render's free plan the service spins down after inactivity and respins
# on the next request -- that respin reuses the same container filesystem and
# re-runs this script without any new code, so rebuilding unconditionally on
# every wake would pay for a full `npm install && npm run build` (a
# minute-plus of dead time) for nothing.
#
# But a *real* deploy also reuses that same filesystem on this plan --
# confirmed directly: dist/ (gitignored, so untouched by git checkout) can
# survive across deploys, and a version of this script that only checked
# "does dist/ exist" (not "is it still the latest commit's build") kept
# serving stale compiled code after real deploys with new source on disk --
# new routes 404ing, bug fixes not taking effect, no error, just silently
# running the previous commit indefinitely. Stamping the built commit SHA and
# comparing it against the checked-out one on every start closes that gap:
# a real deploy (new commit) always rebuilds, a mere wake-from-sleep (same
# commit, same disk) never does.
set -e
BUILT_COMMIT_FILE=dist/.build-commit
CURRENT_COMMIT=$(git -C .. rev-parse HEAD 2>/dev/null || echo "no-git")
BUILT_COMMIT=$(cat "$BUILT_COMMIT_FILE" 2>/dev/null || echo "")

if [ ! -d ../node_modules/pg ] || [ ! -f dist/index.js ] || [ ! -f ../web/dist/index.html ] || [ "$CURRENT_COMMIT" != "$BUILT_COMMIT" ]; then
  echo "[start] Reconstruction nécessaire (build absent, ou commit courant $CURRENT_COMMIT != dernier build $BUILT_COMMIT) -- installation et reconstruction (server + web) avant démarrage..."
  (cd .. && npm install && npm run build)
  mkdir -p dist
  echo "$CURRENT_COMMIT" > "$BUILT_COMMIT_FILE"
else
  echo "[start] Build à jour pour le commit $CURRENT_COMMIT, démarrage direct (pas de reconstruction)."
fi
exec node dist/index.js
