#!/bin/bash
# OrangeRails API deploy on bb-support
# Run on bb-support: cd /opt/orangerails && ./server/deploy.sh
#   or: cd /opt/orangerails/server && ./deploy.sh

set -euo pipefail

cd "$(dirname "$0")"

# Pull from git (read-only via dedicated deploy key — see /home/ubuntu/.ssh/config alias)
cd ../
echo "[deploy] git pull"
git pull --ff-only

cd server/
echo "[deploy] docker compose up -d --build"
docker compose up -d --build

echo "[deploy] verify health"
sleep 3
if curl -fsS http://127.0.0.1:3003/health > /dev/null; then
    echo "[deploy] ✅ orangerails-api healthy at :3003"
else
    echo "[deploy] ❌ health check failed — check logs: docker compose logs --tail=30"
    exit 1
fi
