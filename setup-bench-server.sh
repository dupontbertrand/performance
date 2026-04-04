#!/usr/bin/env bash
# ============================================================
# Meteor Benchmark Server — Provisioning Script
# Target: Hetzner CPX42 (8 vCPU, 16 GB RAM, Ubuntu 24.04)
# Usage: ssh root@<ip> 'bash -s' < setup-bench-server.sh
# ============================================================
set -euo pipefail

echo "=== [1/7] System packages ==="
apt-get update
apt-get install -y \
  build-essential \
  git \
  curl \
  wget \
  htop \
  sysstat \
  ca-certificates \
  gnupg

echo "=== [2/7] Node.js 22 (LTS) ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
echo "Node $(node -v) / npm $(npm -v)"

echo "=== [3/7] MongoDB 7.0 ==="
# MongoDB 7.0 has no noble (24.04) repo — use jammy (22.04) repo, works fine
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
  gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
echo "deb [signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" \
  > /etc/apt/sources.list.d/mongodb-org-7.0.list
apt-get update
apt-get install -y mongodb-org

# Tune MongoDB for benchmarking
cat > /etc/mongod.conf <<'MONGOD'
storage:
  dbPath: /var/lib/mongodb
  wiredTiger:
    engineConfig:
      cacheSizeGB: 6
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
net:
  port: 27017
  bindIp: 127.0.0.1
replication:
  replSetName: rs0
MONGOD

systemctl enable mongod
systemctl start mongod
sleep 2
mongosh --eval 'rs.initiate({_id:"rs0", members:[{_id:0, host:"127.0.0.1:27017"}]})' || true
echo "MongoDB $(mongod --version | head -1)"

echo "=== [4/7] Meteor ==="
curl https://install.meteor.com/ | sh
export METEOR_ALLOW_SUPERUSER=1
echo "Meteor $(meteor --version)"

echo "=== [5/7] Playwright system deps ==="
npx playwright install-deps chromium
npx playwright install chromium

echo "=== [6/7] Clone repos ==="
mkdir -p /opt/bench
cd /opt/bench

# Meteor core (for branch switching)
git clone --no-single-branch --depth 50 \
  https://github.com/meteor/meteor.git meteor-checkout

# Performance repo (bench CLI + apps + scenarios)
git clone https://github.com/dupontbertrand/performance.git performance
cd performance
npm ci

# Install app dependencies
npm install --prefix apps/tasks-3.x
npm install --prefix apps/tasks-2.x

echo "=== [7/7] Environment setup ==="
cat > /opt/bench/bench.env <<'ENV'
export METEOR_CHECKOUT_PATH=/opt/bench/meteor-checkout
export METEOR_ALLOW_SUPERUSER=1
export MONGO_URL=mongodb://127.0.0.1:27017/meteor-bench?replicaSet=rs0
export MONGO_OPLOG_URL=mongodb://127.0.0.1:27017/local
export ROOT_URL=http://localhost:3000
export PORT=3000
export BENCH_DASHBOARD_URL=wss://meteor-benchmark-dashboard.sandbox.galaxycloud.app/websocket
# export BENCH_API_KEY=xxx  # <-- set this manually
ENV

cat >> /root/.bashrc <<'BASHRC'

# Bench shortcuts
source /opt/bench/bench.env
alias bench='cd /opt/bench/performance && node bench.js'
BASHRC

echo "=== [8/8] Bench agent service ==="
cp /opt/bench/performance/bench-agent.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable bench-agent
# Don't start yet — BENCH_API_KEY must be set in bench.env first
echo "Agent service installed (not started — set BENCH_API_KEY in /opt/bench/bench.env first)"

echo ""
echo "============================================"
echo " DONE. Reboot or source /opt/bench/bench.env"
echo ""
echo " Quick test:"
echo "   source /opt/bench/bench.env"
echo "   cd /opt/bench/performance"
echo "   node bench.js list"
echo ""
echo " Run a benchmark:"
echo "   bench run --scenario ddp-reactive-light --tag baseline"
echo ""
echo " Push results to dashboard:"
echo "   bench push --result results/<file>.json"
echo "============================================"
