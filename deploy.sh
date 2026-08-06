#!/usr/bin/env bash
#
# Déploiement sur la VM : code, base, swap, dépendances, pm2.
#
# La base n'est PAS construite ici — construire les pools coûte des heures de
# réseau et plusieurs Go de disque, hors de portée de cette machine. Elle est
# construite en local (`npm run refresh` puis `npm run seed`) et voyage par le
# dépôt sous forme d'archive Git LFS, que ce script décompresse. Le refresh
# qui tourne ici ne suit plus que les listes Populaire/Tendances
# (db/refresh.js --lists-only), la seule donnée qui bouge d'un jour à l'autre.
#
# Idempotent — relançable autant de fois qu'on veut, y compris après un
# reboot. Chaque étape constate l'état avant d'agir.
#
#   ./deploy.sh                 # tout : code, base, swap, npm, serveur + refresh
#   ./deploy.sh --no-pull       # ne touche pas au dépôt (déjà à jour à la main)
#   ./deploy.sh --no-refresh    # serveur seul
#   ./deploy.sh --force-db      # réinstalle la base même si l'empreinte colle
#   ./deploy.sh --full-refresh  # crawl complet ICI (ancien mode, très lourd)
#   ./deploy.sh --skip-swap     # ne touche pas au swap
#   SWAP_SIZE=4G ./deploy.sh    # swapfile plus gros
#
set -euo pipefail

# ---------- réglages ----------

SWAP_SIZE="${SWAP_SIZE:-2G}"
SWAP_FILE="${SWAP_FILE:-/swapfile}"
# bas exprès : le swap doit servir de filet sous vraie pression, pas de
# rangement de confort. Au-dessus, la construction de l'index (60M d'INSERT)
# passe son temps à faire des allers-retours disque.
SWAPPINESS=10

APP_NAME="guess_it"
REFRESH_NAME="guess_it_refresh"

SKIP_SWAP=0
START_REFRESH=1
DO_PULL=1
FULL_REFRESH=0
SEED_FORCE=""
for arg in "$@"; do
  case "$arg" in
    --skip-swap) SKIP_SWAP=1 ;;
    --no-refresh) START_REFRESH=0 ;;
    --no-pull) DO_PULL=0 ;;
    --force-db) SEED_FORCE="--force" ;;
    --full-refresh) FULL_REFRESH=1 ;;
    --swap-size=*) SWAP_SIZE="${arg#*=}" ;;
    -h|--help) sed -n '3,21p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $arg (voir --help)" >&2; exit 1 ;;
  esac
done

# Tas V8 borné explicitement : sur une VM à 1 Go, V8 déduit sa limite de la
# RAM PHYSIQUE et ignore complètement le swap. Sans ça il choisit une valeur
# basse, et une fois le swap en place il refuserait quand même de grandir.
# En mode listes, le process ne garde en mémoire qu'une poignée de pages
# TMDb/IGDB/iTunes ; le mode complet doit en plus loger les dumps Wikimedia,
# d'où les 700 Mo (qui laissent la place au natif : SQLite, Buffers, bzip2).
if [ "$FULL_REFRESH" -eq 1 ]; then
  REFRESH_HEAP_MB="${REFRESH_HEAP_MB:-700}"
  # Pic disque pendant la construction de l'index frwiki : ~5 Go d'index
  # final, + 5,3 Go pour l'archive de pageviews en cours de téléchargement,
  # + le temp des CREATE INDEX, + le swapfile. Voir db/refresh/frwiki-dump.js.
  NEEDED_DISK_GB=14
else
  REFRESH_HEAP_MB="${REFRESH_HEAP_MB:-400}"
  # l'archive LFS (~60 Mo) + sa copie décompressée dans cache/ (~150 Mo) + le
  # temporaire de décompression + l'objet LFS gardé dans .git + le swapfile.
  NEEDED_DISK_GB=3
fi

# ---------- sortie ----------

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==> ERREUR\033[0m %s\n' "$*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ---------- pré-requis ----------

[ "$(uname -s)" = "Linux" ] || die "Ce script vise la VM Linux (uname = $(uname -s))."
command -v node >/dev/null || die "node introuvable."
command -v npm  >/dev/null || die "npm introuvable."
[ -f "$ROOT/package.json" ] || die "package.json absent : mauvais répertoire ?"
[ -f "$ROOT/.env" ] || die ".env absent (TMDB_API_KEY est obligatoire, voir env.example)."

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null; then
  SUDO="sudo"
else
  SUDO=""
fi

# bzip2 n'est pas une dépendance npm : sans lui, les dumps de consultations et
# de résumés sont silencieusement abandonnés au profit de l'API MediaWiki,
# beaucoup plus lente (voir bzip2Available dans db/refresh/frwiki-dump.js).
# Sans intérêt en mode listes, qui ne touche jamais aux dumps.
if [ "$FULL_REFRESH" -eq 1 ]; then
  command -v bzip2 >/dev/null \
    || warn "bzip2 introuvable : pageviews et résumés repasseront par l'API (lent). apt install bzip2"
fi

# ---------- 0. code + archive de la base ----------

log "Dépôt"
if [ "$DO_PULL" -eq 0 ]; then
  ok "laissé tel quel (--no-pull)."
else
  # --ff-only : sur la VM le dépôt n'est qu'un miroir, une divergence est une
  # anomalie qu'il vaut mieux voir échouer ici que résoudre par une fusion
  # automatique dans le dos.
  # bash relit le script au fil de son exécution : si le pull réécrit
  # deploy.sh sous nos pieds, la suite est lue au mauvais offset. On repart
  # donc proprement sur la nouvelle version (une seule fois, d'où le témoin).
  deploy_before="$(cksum < "$0")"
  git -C "$ROOT" pull --ff-only
  if [ "$deploy_before" != "$(cksum < "$0")" ] && [ "${GUESS_IT_REEXEC:-0}" -eq 0 ]; then
    log "  deploy.sh a changé — relance de la nouvelle version…"
    GUESS_IT_REEXEC=1 exec bash "$0" "$@" --no-pull
  fi
  # L'archive de la base est un objet LFS (voir .gitattributes) : sans
  # git-lfs, `git pull` ne ramène qu'un pointeur texte de quelques centaines
  # d'octets, et db/seed.js s'arrêtera là-dessus avec le message qui va bien.
  if command -v git-lfs >/dev/null; then
    git -C "$ROOT" lfs pull
    ok "code et base à jour ($(git -C "$ROOT" rev-parse --short HEAD))."
  else
    warn "git-lfs introuvable : l'archive de la base ne sera pas récupérée. apt install git-lfs"
  fi
fi

# ---------- 1. swap ----------

to_bytes() {
  case "$1" in
    *G|*g) echo $(( ${1%[Gg]} * 1024 * 1024 * 1024 )) ;;
    *M|*m) echo $(( ${1%[Mm]} * 1024 * 1024 )) ;;
    *)     echo "$1" ;;
  esac
}

human_gb() { awk -v b="$1" 'BEGIN { printf "%.1f Go", b / 1024 / 1024 / 1024 }'; }

setup_swap() {
  local want have
  want=$(to_bytes "$SWAP_SIZE")
  have=$(( $(awk '/^SwapTotal:/ {print $2}' /proc/meminfo) * 1024 ))

  log "Swap"
  if [ "$have" -ge "$want" ]; then
    ok "déjà $(human_gb "$have") actifs (>= $SWAP_SIZE demandés), rien à faire."
  else
    [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ] \
      || die "swap insuffisant ($(human_gb "$have")) et ni root ni sudo pour le créer. Relancer avec sudo, ou --skip-swap."

    if [ -e "$SWAP_FILE" ]; then
      # fichier présent mais pas (ou plus) activé : typiquement après un reboot
      # sans entrée fstab. On tente de le réactiver avant d'envisager de le
      # recréer — inutile de réécrire des gigaoctets pour rien.
      log "  $SWAP_FILE existe déjà, tentative de réactivation…"
      if $SUDO swapon "$SWAP_FILE" 2>/dev/null; then
        ok "réactivé."
      else
        warn "réactivation impossible, le fichier est recréé."
        $SUDO swapoff "$SWAP_FILE" 2>/dev/null || true
        $SUDO rm -f "$SWAP_FILE"
      fi
    fi

    if [ ! -e "$SWAP_FILE" ]; then
      log "  création de $SWAP_FILE ($SWAP_SIZE)…"
      # fallocate échoue sur certains systèmes de fichiers (btrfs sans
      # préparation, quelques overlays de conteneur) : dd est plus lent mais
      # marche partout.
      if ! $SUDO fallocate -l "$SWAP_SIZE" "$SWAP_FILE" 2>/dev/null; then
        warn "fallocate indisponible, repli sur dd (plus lent)."
        $SUDO dd if=/dev/zero of="$SWAP_FILE" bs=1M count=$(( want / 1024 / 1024 )) status=none
      fi
      $SUDO chmod 600 "$SWAP_FILE"
      $SUDO mkswap "$SWAP_FILE" >/dev/null
      $SUDO swapon "$SWAP_FILE"
      ok "swapfile actif."
    fi

    # persistance au reboot — le point qui vient de te coûter un redémarrage.
    if ! grep -qs "^$SWAP_FILE " /etc/fstab; then
      printf '%s none swap sw 0 0\n' "$SWAP_FILE" | $SUDO tee -a /etc/fstab >/dev/null
      ok "entrée ajoutée à /etc/fstab (survit au reboot)."
    else
      ok "déjà dans /etc/fstab."
    fi
  fi

  # swappiness, à chaque passage : une valeur par défaut (60) ferait swapper
  # bien avant la vraie pression, et ralentirait la construction de l'index.
  if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
    $SUDO sysctl -q -w vm.swappiness=$SWAPPINESS
    printf 'vm.swappiness=%s\n' "$SWAPPINESS" \
      | $SUDO tee /etc/sysctl.d/99-guess-it.conf >/dev/null
    ok "vm.swappiness=$SWAPPINESS (persisté)."
  fi
}

if [ "$SKIP_SWAP" -eq 1 ]; then
  log "Swap — ignoré (--skip-swap)."
else
  setup_swap
fi

# ---------- 2. disque ----------

log "Disque"
avail_gb=$(( $(df -Pk "$ROOT" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
if [ "$avail_gb" -lt "$NEEDED_DISK_GB" ]; then
  if [ "$FULL_REFRESH" -eq 1 ]; then
    warn "$avail_gb Go libres, ~$NEEDED_DISK_GB Go recommandés pour construire l'index frwiki."
    warn "Le refresh démarrera quand même, mais peut mourir en ENOSPC pendant les dumps."
  else
    warn "$avail_gb Go libres, ~$NEEDED_DISK_GB Go recommandés pour décompresser la base."
    warn "L'installation de la base peut mourir en ENOSPC."
  fi
else
  ok "$avail_gb Go libres (>= $NEEDED_DISK_GB Go)."
fi

# ---------- 3. dépendances ----------

log "Dépendances npm"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
ok "à jour."

if ! command -v pm2 >/dev/null; then
  log "Installation de pm2…"
  $SUDO npm install -g pm2
fi
ok "pm2 $(pm2 --version)"

# ---------- 4. base ----------

# `check` répond par son code de sortie : 0 « à installer », 1 « déjà à jour »
# (une simple mise à jour de code, sans coupure), 2 « problème » — voir
# EXIT_PROBLEM dans db/seed.js. `set -e` doit être levé le temps de lire le
# code, sinon 1 et 2 tueraient tous deux le script sans distinction.
log "Base"
set +e
node db/seed.js check $SEED_FORCE
seed_rc=$?
set -e
case "$seed_rc" in
  0)
    # db/seed.js remplace le FICHIER cache/data.sqlite (et supprime les -wal/
    # -shm de l'ancienne, qui ne décrivent plus rien) : personne ne doit le
    # tenir ouvert pendant l'opération.
    pm2 stop "$APP_NAME" "$REFRESH_NAME" >/dev/null 2>&1 || true
    node db/seed.js install $SEED_FORCE
    ok "base installée depuis le dépôt."
    ;;
  1) ok "base déjà à jour, aucune coupure." ;;
  *) die "base indisponible (voir ci-dessus) — rien n'a été déployé." ;;
esac

# ---------- 5. pm2 ----------

# On démarre node DIRECTEMENT plutôt que `pm2 start npm -- run x` : pm2
# supervise alors le vrai process node (mémoire correctement mesurée,
# --node-args pris en compte, redémarrage propre) au lieu du npm qui le forke.
# --cwd est obligatoire : config.js et db/connection.js résolvent config.json
# et cache/ depuis process.cwd().
start_app() {
  local name="$1"; shift
  # Tout ce qui suit un `--` est destiné au SCRIPT, pas à pm2 — et pm2 exige
  # de le trouver en toute FIN de ligne : laissé au milieu, ce sont --name/
  # --cwd/--time qui partiraient au script au lieu de configurer pm2.
  local pm2_args=() script_args=()
  while [ $# -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; script_args=("$@"); break; fi
    pm2_args+=("$1"); shift
  done
  if pm2 describe "$name" >/dev/null 2>&1; then
    pm2 delete "$name" >/dev/null
  fi
  if [ ${#script_args[@]} -gt 0 ]; then
    pm2 start "${pm2_args[@]}" --name "$name" --cwd "$ROOT" --time -- "${script_args[@]}"
  else
    pm2 start "${pm2_args[@]}" --name "$name" --cwd "$ROOT" --time
  fi
}

if [ "$START_REFRESH" -eq 1 ]; then
  # --lists-only par défaut : la base arrive construite, ce process ne suit
  # plus que les listes Populaire/Tendances (voir l'en-tête de ce fichier).
  # --full-refresh rend l'ancien comportement — crawl complet sur la VM —
  # qui reste possible mais demande les 14 Go de disque et des heures.
  if [ "$FULL_REFRESH" -eq 1 ]; then
    REFRESH_MODE=""
    log "pm2 — $REFRESH_NAME (db/refresh.js, CRAWL COMPLET)"
  else
    REFRESH_MODE="--lists-only"
    log "pm2 — $REFRESH_NAME (db/refresh.js --lists-only)"
  fi
  # restart-delay : le refresh boucle indéfiniment, s'il sort c'est une
  # anomalie — on laisse respirer plutôt que de repartir dans la seconde sur
  # la même erreur (réseau coupé, disque plein).
  start_app "$REFRESH_NAME" db/refresh.js \
    --node-args="--max-old-space-size=$REFRESH_HEAP_MB" \
    --restart-delay=30000 \
    -- $REFRESH_MODE
  ok "démarré (tas V8 borné à $REFRESH_HEAP_MB Mo)."
else
  log "pm2 — $REFRESH_NAME laissé tel quel (--no-refresh)."
fi

log "pm2 — $APP_NAME (server.js)"
start_app "$APP_NAME" server.js
ok "démarré."

pm2 save >/dev/null
ok "liste pm2 sauvegardée."

# relance pm2 au boot. `pm2 startup` imprime normalement une commande à copier ;
# lancé avec les droits qu'il faut, il l'exécute lui-même.
if [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; then
  if ! systemctl is-enabled pm2-"$(id -un)" >/dev/null 2>&1; then
    log "Activation du démarrage automatique de pm2…"
    $SUDO env PATH="$PATH" pm2 startup systemd -u "$(id -un)" --hp "$HOME" >/dev/null \
      && ok "pm2 redémarrera au boot." \
      || warn "pm2 startup a échoué — à faire à la main : pm2 startup"
  else
    ok "démarrage automatique déjà actif."
  fi
fi

# ---------- récapitulatif ----------

echo
pm2 status
echo
log "Terminé."
echo "    logs serveur : pm2 logs $APP_NAME"
echo "    logs refresh : pm2 logs $REFRESH_NAME"
echo "    mémoire/swap : free -h"
if [ "$FULL_REFRESH" -eq 0 ]; then
  echo
  echo "    Pour enrichir le contenu (nouveaux films, images, types…), c'est en local :"
  echo "      npm run refresh && npm run seed"
  echo "      git add dist && git commit -m \"seed\" && git push"
  echo "    puis ./deploy.sh ici. Le refresh d'ici ne suit que les listes."
fi
