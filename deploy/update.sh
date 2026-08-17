#!/bin/bash
# Update Mesh Planner from GitHub and restart the service.
# Install:  ln -sf /opt/meshplanner/deploy/update.sh /usr/local/bin/meshplanner-update
set -euo pipefail

cd /opt/meshplanner
echo "== pulling latest from GitHub =="
git fetch origin
git reset --hard origin/main
echo "== restarting service =="
systemctl restart meshplanner
sleep 3
systemctl is-active meshplanner
curl -s localhost:8620/api/health | head -c 120
echo
echo "== updated to $(git log --oneline -1) =="
