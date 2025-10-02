#!/usr/bin/env bash

# app. Application directory name within ./apps/*
# script. Artillery script name within ./artillery/*
app="${1}"
script="${2}"
logName="${3:-''}"
if [[ -z "${app}" ]] || [[ -z "${script}" ]]; then
  echo "Usage: monitor-replicaset.sh <app_name> <script_name>"
  exit 1
fi

# Redirect stdout (1) and stderr (2) to a file
logFile="logs/${logName}-${app}-${script}.log"
mkdir -p logs
exec > "./${logFile}" 2>&1

# Initialize script constants
baseDir="${PWD}"
appsDir="${baseDir}/apps"
appPath="${appsDir}/${app}"
appPort=3000

# Define color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Track replica monitor processes
declare -a replicaDbPids=()
declare -a replicaDbLabels=()
declare -a replicaMonitorPids=()
artPid=""
cpuRamAppPid=""

# Define helpers
function getPidByName() {
  ps aux | grep "${1}" | grep -v grep | awk '{print $2}'
}

function getPidByPort() {
  local port="${1}"
  lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null | head -n 1
}

function loadEnv() {
  if [[ -f $1 ]]; then
    # shellcheck disable=SC1090
    source "${1}"
    while read -r line; do
      eval "export ${line}"
    done <"$1"
  fi
}

function formatToEnv() {
  local str="${1}"
  str=$(echo ${str} | sed -r -- 's/ /_/g')
  str=$(echo ${str} | sed -r -- 's/\./_/g')
  str=$(echo ${str} | sed -r -- 's/\-/_/g')
  str=$(echo ${str} | tr -d "[@^\\\/<>\"'=]" | tr -d '*')
  str=$(echo ${str} | sed -r -- 's/\//_/g')
  str=$(echo ${str} | sed -r -- 's/,/_/g')
  str=$(echo ${str} | sed 'y/abcdefghijklmnopqrstuvwxyz/ABCDEFGHIJKLMNOPQRSTUVWXYZ/')
  echo "${str}"
}

function getEnvVarValue() {
  local key="${1}"
  eval "printf '%s' \"\${${key}}\""
}

function trimSpaces() {
  echo "${1}" | sed 's/^ *//;s/ *$//'
}

function isRunningUrl() {
  local url="${1}"
  local urlStatus="$(curl -Is "${url}" | head -1)"
  echo "${urlStatus}" | grep -q "200"
}

function waitMeteorApp() {
  PROCESS_WAIT_TIMEOUT=3600000
  processWaitTimeoutSecs=$((PROCESS_WAIT_TIMEOUT / 1000))
  waitSecs=0
  while ! isRunningUrl "http://localhost:${appPort}" && [[ "${waitSecs}" -lt "${processWaitTimeoutSecs}" ]]; do
    sleep 1
    waitSecs=$((waitSecs + 1))
  done
}

function getMontiAppId() {
  local envKey="$(formatToEnv ${app})"
  local value="$(getEnvVarValue "MONTI_APP_ID")"
  echo "${value}"
}

function getMontiAppSecret() {
  local envKey="$(formatToEnv ${app})"
  local value="$(getEnvVarValue "MONTI_APP_SECRET")"
  echo "${value}"
}

function getReplicaMongoUrl() {
  local envKey="$(formatToEnv ${app})"
  local url="$(getEnvVarValue "MONGO_URL")"
  if [[ -n "${url}" ]]; then
    echo "${url}"
    return
  fi

  echo "${url}"
}

function getReplicaOplogUrl() {
  local envKey="$(formatToEnv ${app})"
  local url="$(getEnvVarValue "MONGO_OPLOG_URL")"
  if [[ -n "${url}" ]]; then
    echo "${url}"
    return
  fi
  echo "${url}"
}

function dropTestDatabase() {
  if ! command -v mongosh >/dev/null 2>&1; then
    echo "mongosh not found; skipping test database cleanup."
    return
  fi

  local uri="${1}"
  if [[ -z "${uri}" ]]; then
    echo "No Mongo URI supplied to dropTestDatabase."
    return
  fi

  echo "Dropping 'test' database before running benchmarks..."
  if ! mongosh --quiet "${uri}" --eval 'db.getSiblingDB("test").dropDatabase();' >/dev/null 2>&1; then
    echo "Failed to drop 'test' database. Continuing anyway."
  else
    echo "'test' database dropped successfully."
  fi
}

function logScriptConfig() {
  echo -e "==============================="
  echo -e " Artillery Configuration - $(date) "
  echo -e "==============================="
  cat "${baseDir}/artillery/${script}"
  echo -e "==============================="
}

function logMeteorVersion() {
  echo -e "==============================="
  if [[ -n "${METEOR_CHECKOUT_PATH}" ]]; then
    local oldPath="${PWD}"
    builtin cd "${METEOR_CHECKOUT_PATH}"
    echo -e " Meteor checkout version - $(git rev-parse HEAD)"
    builtin cd "${oldPath}"
  else
    echo -e " Meteor version - $(cat .meteor/release)"
  fi
  echo -e "==============================="
}

function collectReplicaDbPids() {
  local url="${1}"
  local stripped="${url#*://}"
  stripped="${stripped#*@}"
  stripped="${stripped%%/*}"
  stripped="${stripped%%\?*}"

  if [[ -z "${stripped}" ]]; then
    echo "Unable to parse hosts from replicaset url: ${url}"
    return 1
  fi

  IFS=',' read -ra hostEntries <<< "${stripped}"

  for entry in "${hostEntries[@]}"; do
    local trimmed="$(trimSpaces "${entry}")"
    if [[ -z "${trimmed}" ]]; then
      continue
    fi

    local host="${trimmed}"
    local port="27017"

    if [[ "${trimmed}" =~ ^\[(.*)\]:(.*)$ ]]; then
      host="${BASH_REMATCH[1]}"
      port="${BASH_REMATCH[2]}"
    elif [[ "${trimmed}" =~ ^\[(.*)\]$ ]]; then
      host="${BASH_REMATCH[1]}"
    elif [[ "${trimmed}" == *:* ]]; then
      host="${trimmed%:*}"
      port="${trimmed##*:}"
    fi

    local pid="$(getPidByPort "${port}")"
    if [[ -z "${pid}" ]]; then
      echo "Could not find a local mongod process listening on port ${port} for host ${host}."
      continue
    fi

    local labelSuffix="${host}_${port}"
    labelSuffix=$(echo "${labelSuffix}" | sed -r 's/[^A-Za-z0-9_]/_/g')
    local label="REPLICA_${labelSuffix}"

    replicaDbPids+=("${pid}")
    replicaDbLabels+=("${label}")

    echo "Replica node ${host}:${port} PID: ${pid}"
  done

  if [[ "${#replicaDbPids[@]}" -eq 0 ]]; then
    echo "No replicaset mongod processes could be identified locally."
    return 1
  fi

  return 0
}

function startReplicaMonitors() {
  local helperPath="${baseDir}/scripts/helpers/monitor-cpu-ram.js"
  for idx in "${!replicaDbPids[@]}"; do
    local pid="${replicaDbPids[$idx]}"
    local label="${replicaDbLabels[$idx]}"
    node "${helperPath}" "${pid}" "${label}" &
    local monitorPid="$!"
    replicaMonitorPids+=("${monitorPid}")
    echo "Monitor CpuRam ${label} Pid ${monitorPid}"
  done
}

# Ensure proper cleanup on interrupt the process
function cleanup() {
    local mode="${1}"
    local exitCode=0

    if [[ "${mode}" == "error" ]]; then
      exitCode=1
    elif [[ "${mode}" == "true" ]]; then
      exitCode=0
    elif [[ "${mode}" == "signal" ]]; then
      exitCode=130
    fi

    if [[ -n "${ENABLE_APM}" ]]; then
      METEOR_PACKAGE_DIRS="${baseDir}/packages" meteor remove apm-agent
    fi

    builtin cd ${baseDir} >/dev/null 2>&1 || true

    if [[ -n "${artPid}" ]]; then
      pkill -P ${artPid} 2>/dev/null || true
    fi

    if [[ -n "${cpuRamAppPid}" ]]; then
      kill -s TERM ${cpuRamAppPid} 2>/dev/null || true
    fi

    for pid in "${replicaMonitorPids[@]}"; do
      kill -s TERM "${pid}" 2>/dev/null || true
    done

    pkill -P $$ 2>/dev/null || true

    if [[ "${mode}" == "true" ]]; then
      sleep 6
      if cat "${baseDir}/${logFile}" | grep -q " Timeout "; then
        echo -e "${RED}*** !!! ERROR: SOMETHING WENT WRONG !!! ***${NC}"
        echo -e "${RED}Output triggered an unexpected timeout (${logFile})${NC}"
        echo -e "${RED} Replicaset database is overloaded and unable to provide accurate comparison results.${NC}"
        echo -e "${RED} Try switching to a configuration that your replicaset can handle.${NC}"
        exit 1
      else
        echo -e "${GREEN}Output is suitable for comparisons (${logFile})${NC}"
        echo -e "${GREEN} Replicaset managed the configuration correctly.${NC}"
        exit 0
      fi
    fi

    exit ${exitCode}
}
trap 'cleanup signal' SIGINT SIGTERM

if ! command -v lsof >/dev/null 2>&1; then
  echo "Command 'lsof' is required to identify mongod processes. Please install it before running this script."
  exit 1
fi

if [[ ! -d "${appPath}" ]]; then
  echo "App path not found: ${appPath}"
  exit 1
fi

logScriptConfig

function logEnvVariables() {
  echo -e "==============================="
  echo -e " Environment Variables - $(date) "
  echo -e "==============================="
  local envKey="$(formatToEnv ${app})"
  declare -a envKeys=(
    "MONGO_URL"
    "MONGO_OPLOG_URL"
    "MONTI_APP_ID"
    "MONTI_APP_SECRET"
    "ENABLE_APM"
    "METEOR_CHECKOUT_PATH"
    "SKIP_KILL_CONTAINERS"
    "GALAXY_API_KEY"
    "GALAXY_TOKEN"
  )

  for key in "${envKeys[@]}"; do
    echo "${key} = $(getEnvVarValue "${key}")"
  done
  echo -e "==============================="
}

loadEnv "${baseDir}/.env"
if [[ -f "${baseDir}/.env.replicaset" ]]; then
  loadEnv "${baseDir}/.env.replicaset"
fi

logEnvVariables

replicaMongoUrl="$(getReplicaMongoUrl)"
if [[ -z "${replicaMongoUrl}" ]]; then
  echo "No replicaset Mongo URL provided. Set MONGO_REPLICA_URL or MONGO_URL (optionally with _$(formatToEnv ${app}) suffix)."
  exit 1
fi

replicaOplogUrl="$(getReplicaOplogUrl)"

dropTestDatabase "${replicaMongoUrl}"

# Prepare, run and wait meteor app
builtin cd "${appPath}"

if [[ -n "${ENABLE_APM}" ]]; then
  export MONTI_APP_ID="$(getMontiAppId)"
  export MONTI_APP_SECRET="$(getMontiAppSecret)"
  METEOR_PACKAGE_DIRS="${baseDir}/packages" meteor add apm-agent
fi

rm -rf "${appPath}/.meteor/local"
logMeteorVersion

export MONGO_URL="${replicaMongoUrl}"
if [[ -n "${replicaOplogUrl}" ]]; then
  export MONGO_OPLOG_URL="${replicaOplogUrl}"
fi

if [[ -n "${METEOR_CHECKOUT_PATH}" ]]; then
  METEOR_PACKAGE_DIRS="${baseDir}/packages" ${METEOR_CHECKOUT_PATH}/meteor run --port ${appPort} --settings ${baseDir}/apps/${app}/settings.json &
else
  METEOR_PACKAGE_DIRS="${baseDir}/packages" meteor run --port ${appPort} --settings ${baseDir}/apps/${app}/settings.json &
fi
waitMeteorApp

appPid="$(getPidByName "${app}/.meteor/local/build/main.js")"
if [[ -z "${appPid}" ]]; then
  echo "Could not determine Meteor app PID."
  cleanup error
fi
echo "APP PID: ${appPid}"

if ! collectReplicaDbPids "${replicaMongoUrl}"; then
  cleanup error
fi

echo "Replica PIDs: ${replicaDbPids[*]}"

# Run artillery script
npx artillery run "${baseDir}/artillery/${script}" &
artPid="$!"

# Run CPU and RAM monitoring for meteor app and replica nodes
node "${baseDir}/scripts/helpers/monitor-cpu-ram.js" "${appPid}" "APP" &
cpuRamAppPid=$(getPidByName "${baseDir}/scripts/helpers/monitor-cpu-ram.js ${appPid} APP")
if [[ -z "${cpuRamAppPid}" ]]; then
  cpuRamAppPid="$!"
fi
echo "Monitor CpuRam APP Pid ${cpuRamAppPid}"

startReplicaMonitors

# Wait for artillery script to finish the process
wait "${artPid}"

cleanup true
