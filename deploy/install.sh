#!/bin/sh
# Install or update CHIRON on an Ubuntu VPS. Run as root, from anywhere:
#   sh install.sh chiron.example.com you@example.com
# It adds its own user, folder, service and nginx site and touches nothing else on the server.
# Running it again updates the code (git pull) and restarts the service; /etc/chiron.env and data/ are kept.
set -eu
DOMAIN="${1:-}"; EMAIL="${2:-}"
REPO="${CHIRON_REPO:-https://github.com/haapiid/chiron.git}"
DIR=/opt/chiron; PORT=5496

[ "$(id -u)" = 0 ] || { echo "Run this as root (sudo sh install.sh ...)."; exit 1; }
[ -n "$DOMAIN" ] || { echo "Usage: sh install.sh <domain> [email for the HTTPS certificate]"; exit 1; }

echo "== 1/6 packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl nginx ca-certificates >/dev/null
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || true)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "   Node 22 is needed (found: $(node -v 2>/dev/null || echo none)); installing it from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "   node $(node -v)"

echo "== 2/6 code in $DIR"
id chiron >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin chiron
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only
else
  # the port must be free on a first install: another app may already use it
  if ss -ltn 2>/dev/null | grep -q ":$PORT "; then echo "Port $PORT is already in use on this server. Nothing was installed."; exit 1; fi
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
npm ci --omit=dev --no-audit --no-fund >/dev/null
mkdir -p "$DIR/data"
chown -R root:root "$DIR"
chown -R chiron:chiron "$DIR/data"
chmod 700 "$DIR/data"

echo "== 3/6 settings in /etc/chiron.env"
if [ ! -f /etc/chiron.env ]; then
  cat > /etc/chiron.env <<EOF
# CHIRON settings (all optional). After a change: systemctl restart chiron
# A private Robinhood Chain RPC first keeps the public one's rate limits away (comma-separated).
RPC_URLS=https://rpc.mainnet.chain.robinhood.com
# Share of every buy that goes into Chiron's own token once its CA is set in /studio (0 = off).
CHIRON_SHARE=0.1
# Password of /studio. Leave it out to use the one the server writes to $DIR/data/burn/secrets.json.
#STUDIO_KEY=
EOF
  chmod 600 /etc/chiron.env
  echo "   written (edit it later if you have a private RPC)"
else echo "   kept as it is"; fi

echo "== 4/6 service"
cp "$DIR/deploy/chiron.service" /etc/systemd/system/chiron.service
systemctl daemon-reload
systemctl enable chiron >/dev/null 2>&1
systemctl restart chiron
sleep 4
if curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null; then echo "   chiron answers on 127.0.0.1:$PORT"
else echo "   chiron does not answer. See: journalctl -u chiron -n 50"; exit 1; fi

echo "== 5/6 nginx site for $DOMAIN"
sed "s/__DOMAIN__/$DOMAIN/g" "$DIR/deploy/nginx-chiron.conf" > /etc/nginx/sites-available/chiron
ln -sf /etc/nginx/sites-available/chiron /etc/nginx/sites-enabled/chiron
if nginx -t 2>/dev/null; then systemctl reload nginx; echo "   nginx reloaded"
else rm -f /etc/nginx/sites-enabled/chiron; echo "   nginx refused the new site, so it was taken out again. Other sites are untouched. See: nginx -t"; exit 1; fi

echo "== 6/6 HTTPS"
# with an email a Let's Encrypt account is registered; without one, the account this server already has is used
if [ -n "$EMAIL" ]; then WHO="--agree-tos -m $EMAIL"
elif ls /etc/letsencrypt/accounts/*/directory/* >/dev/null 2>&1; then WHO=""
else WHO="none"; fi
if [ "$WHO" = "none" ]; then
  echo "   skipped: no email given and this server has no Let's Encrypt account yet. Run: certbot --nginx -d $DOMAIN --redirect"
else
  command -v certbot >/dev/null 2>&1 || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  # shellcheck disable=SC2086
  if certbot --nginx -d "$DOMAIN" --redirect --non-interactive $WHO; then echo "   https://$DOMAIN is live"
  else echo "   The certificate was not issued. Point $DOMAIN (A record) at this server, then run: certbot --nginx -d $DOMAIN --redirect"; fi
fi

echo
echo "Done. The first seven are drawn after a day of Pons trades has been read (several minutes on a first start)."
echo "Studio password: grep studioKey $DIR/data/burn/secrets.json   (or set STUDIO_KEY in /etc/chiron.env)"
echo "Logs: journalctl -u chiron -f      Update later: sh $DIR/deploy/install.sh $DOMAIN"
