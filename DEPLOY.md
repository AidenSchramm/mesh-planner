# Deploying Mesh Planner to a Vultr VPS

The app is a single zero-dependency Node server; the smallest Vultr instance is
plenty. Total cost: ~$5–6/month + a domain (optional but recommended for HTTPS).

This guide uses systemd + Caddy directly (what mesh.womod.org runs).
**Docker alternative:** `docker compose up -d` with the included Dockerfile
does the same thing in one command — put Caddy or any reverse proxy in front
and mount/back up the `meshplanner-data` volume instead of `/var/lib/meshplanner`.
(Note: the Docker path is provided as a convenience and hasn't been exercised
in this deployment.)

## 1. Create the instance

1. Vultr → Deploy New Server → **Cloud Compute — Shared CPU**.
2. Choose a region near you (e.g. Chicago for the upper Midwest).
3. Image: **Ubuntu 24.04 LTS**.
4. Plan: the cheapest (1 vCPU / 1 GB RAM / 25 GB SSD) is more than enough.
5. Add your SSH key. Deploy, note the IP.

## 2. DNS (optional, for HTTPS)

Add an `A` record for e.g. `mesh.yourdomain.com` → the VPS IP. Without a domain
you can still use `http://<ip>:8620`, but you won't get TLS.

## 3. Install Node and Caddy

SSH in as root:

```bash
apt-get update && apt-get -y upgrade
# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
# Caddy (automatic HTTPS reverse proxy)
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

## 4. Install the app

```bash
useradd --system --home /opt/meshplanner --shell /usr/sbin/nologin meshplanner
mkdir -p /opt/meshplanner /var/lib/meshplanner
```

Clone the repo (on the VPS):

```bash
git clone https://github.com/AidenSchramm/mesh-planner.git /opt/meshplanner
chown -R meshplanner:meshplanner /var/lib/meshplanner
cp /opt/meshplanner/deploy/meshplanner.service /etc/systemd/system/
ln -sf /opt/meshplanner/deploy/update.sh /usr/local/bin/meshplanner-update
systemctl daemon-reload
systemctl enable --now meshplanner
systemctl status meshplanner        # should be active; check journalctl -u meshplanner on issues
curl -s localhost:8620/api/health   # {"ok":true,...}
```

Instance-specific configuration (extra data sources, MQTT regions) goes in a
systemd drop-in so it survives updates and stays out of git:

```bash
mkdir -p /etc/systemd/system/meshplanner.service.d
cat > /etc/systemd/system/meshplanner.service.d/local.conf <<'EOF'
[Service]
Environment=EXTRA_SOURCES=https://potato.sodakmesh.org
EOF
systemctl daemon-reload && systemctl restart meshplanner
```

## 5. HTTPS via Caddy

Edit `/etc/caddy/Caddyfile` to the contents of `deploy/Caddyfile` (with your real
domain), then:

```bash
systemctl reload caddy
```

## 6. Firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Port 8620 stays unexposed; Caddy proxies to it on localhost.

## 7. Daily backups

```bash
cp /opt/meshplanner/deploy/meshplanner-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now meshplanner-backup.timer
```

Keeps 14 daily archives of the data files in `/var/lib/meshplanner/backups/`.

## 8. Updating the app

Push to GitHub, then on the VPS (or via ssh in one line):

```bash
ssh root@<VPS-IP> meshplanner-update
```

This fetches origin/main, hard-resets the working tree to it, restarts the
service, and prints the health check plus the deployed commit.

## Data & backups

Everything user-generated lives in `/var/lib/meshplanner`:

- `overrides.json` — current node corrections (shared by all visitors)
- `history.jsonl` — append-only log of every correction ever made
- `geocode-cache.json` — cached geocoding results
- `tiles/` — cached terrain tiles (safe to delete; refetched on demand)

Back up the first two:

```bash
ssh root@<VPS-IP> tar czf - -C /var/lib/meshplanner overrides.json history.jsonl > meshplanner-backup.tgz
```

## Notes

- The server makes at most one ~33 MB upstream node-DB fetch per 5 minutes
  regardless of visitor count, rate-limits geocoding to Nominatim at 1 req/sec
  with long-lived caching, and serves terrain tiles from its own disk cache —
  so it is a polite citizen toward all upstream services.
- Corrections are shared and unauthenticated by design (community-editable, like
  a wiki, with full history in `history.jsonl` for undoing vandalism). If you
  want to restrict editing, put Caddy `basic_auth` in front of `/api/overrides`.
- RAM: steady-state ~150–250 MB. The 1 GB instance leaves ample headroom.
