#!/bin/bash

# Start a three-node MongoDB replica set inside a single container.

set -euo pipefail

REPLSET_NAME="${REPLSET_NAME:-rs0}"
REPLSET_ADVERTISED_HOST="${REPLSET_ADVERTISED_HOST:-localhost}"

MONGOD_BIN="mongod"
DATA_DIR="/data/mongo-replica"
PORTS=("unused" "27017" "27018" "27019")

echo "Starting MongoDB Replica Set: ${REPLSET_NAME}"

for i in 1 2 3; do
  mkdir -p "${DATA_DIR}/node$((i-1))"
done

for i in 1 2 3; do
  port=${PORTS[$i]}
  echo "Starting node $((i-1)) on port ${port} with replSet ${REPLSET_NAME}"
  "${MONGOD_BIN}" --replSet "${REPLSET_NAME}" \
                  --port "${port}" \
                  --dbpath "${DATA_DIR}/node$((i-1))" \
                  --bind_ip 0.0.0.0 \
                  --fork \
                  --logpath "${DATA_DIR}/node$((i-1))/mongod.log" \
                  --oplogSize 50
done

echo "Waiting for MongoDB nodes to start..."
sleep 10

echo "Initializing replica set..."
mongosh --port 27017 --eval "
try {
  rs.initiate({
    _id: '${REPLSET_NAME}',
    members: [
      { _id: 0, host: '${REPLSET_ADVERTISED_HOST}:27017' },
      { _id: 1, host: '${REPLSET_ADVERTISED_HOST}:27018' },
      { _id: 2, host: '${REPLSET_ADVERTISED_HOST}:27019' }
    ]
  });
  print('Replica set initialized successfully');
} catch (e) {
  print('Error initializing replica set: ' + e);
}
"

echo "Replica set '${REPLSET_NAME}' started successfully!"
echo "Available connections:"
echo "  Primary: mongodb://${REPLSET_ADVERTISED_HOST}:27017"
echo "  Full replica set: mongodb://${REPLSET_ADVERTISED_HOST}:27017,${REPLSET_ADVERTISED_HOST}:27018,${REPLSET_ADVERTISED_HOST}:27019/?replicaSet=${REPLSET_NAME}"

echo "Monitoring replica set... (Ctrl+C to stop)"
tail -f "${DATA_DIR}"/node*/mongod.log
