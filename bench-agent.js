/**
 * Bench Agent — Polls the dashboard for pending jobs and executes them.
 *
 * Runs on the Hetzner benchmark server as a systemd service.
 * Uses SimpleDDP to connect to the dashboard via WebSocket.
 *
 * Usage:
 *   node bench-agent.js
 *
 * Environment:
 *   BENCH_DASHBOARD_URL  - Dashboard WebSocket URL (default from bench.config.js)
 *   BENCH_API_KEY        - API key for authentication
 *   METEOR_CHECKOUT_PATH - Path to Meteor checkout for branch switching
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const SimpleDDP = require('simpleddp');
const ws = require('ws');
const config = require('./bench.config.js');

const POLL_INTERVAL = 30_000; // 30 seconds
const BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
const MAX_LOG_LENGTH = 2000; // max chars of stderr to store in job error

const DASHBOARD_URL = process.env.BENCH_DASHBOARD_URL?.trim()
  || config.dashboardUrl
  || 'ws://localhost:4000/websocket';

const API_KEY = process.env.BENCH_API_KEY
  || config.dashboardApiKey
  || 'dev-bench-key-change-in-prod';

const METEOR_CHECKOUT = process.env.METEOR_CHECKOUT_PATH
  || config.meteorCheckoutPath;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// DDP call with retry on disconnect — waits for reconnection then retries
async function ddpCall(ddp, method, ...args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await ddp.call(method, ...args);
    } catch (err) {
      const isDisconnect = err.message?.includes('disconnected')
        || err.message?.includes('WebSocket')
        || err.message?.includes('not connected');
      if (isDisconnect && attempt < 2) {
        log(`DDP call failed (${method}), waiting for reconnection... (attempt ${attempt + 1})`);
        await sleep(10_000);
        continue;
      }
      throw err;
    }
  }
}

async function createDDP() {
  const ddp = new SimpleDDP({
    endpoint: DASHBOARD_URL,
    SocketConstructor: ws,
    reconnectInterval: 5000,
  });
  await ddp.connect();
  log(`Connected to ${DASHBOARD_URL}`);
  return ddp;
}

function checkoutBranch(branch) {
  if (!BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  log(`Checking out origin/${branch}...`);
  execSync('git fetch origin', { cwd: METEOR_CHECKOUT, stdio: 'pipe' });
  execSync(`git checkout origin/${branch} --detach`, { cwd: METEOR_CHECKOUT, stdio: 'pipe' });
  const sha = execSync('git rev-parse --short HEAD', { cwd: METEOR_CHECKOUT, encoding: 'utf8' }).trim();
  log(`Checked out ${branch} at ${sha}`);
  return sha;
}

function runBenchmark(scenario, tag) {
  log(`Running benchmark: scenario=${scenario} tag=${tag}`);
  const cmd = `node bench.js run --scenario ${scenario} --tag ${tag}`;
  const result = spawnSync('node', ['bench.js', 'run', '--scenario', scenario, '--tag', tag], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 2 * 60 * 60 * 1000,
    env: { ...process.env, METEOR_ALLOW_SUPERUSER: '1' },
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (result.status !== 0) {
    // Capture last N chars of stderr for the error log
    const tailLog = stderr.slice(-MAX_LOG_LENGTH);
    throw new Error(`bench.js exited with code ${result.status}\n${tailLog}`);
  }

  // Find the result file path from output
  const match = stdout.match(/Results written to: (.+\.json)/);
  if (!match) {
    const tailLog = (stdout + '\n' + stderr).slice(-MAX_LOG_LENGTH);
    throw new Error(`Could not find result file path in bench.js output\n${tailLog}`);
  }
  return match[1].trim();
}

async function executeJob(ddp, job) {
  log(`=== Executing job ${job._id}: branch=${job.branch}, scenarios=${job.scenarios.join(', ')}`);
  const runIds = [];

  try {
    checkoutBranch(job.branch);

    for (let i = 0; i < job.scenarios.length; i++) {
      const scenario = job.scenarios[i];

      // Check if job was cancelled between scenarios
      if (i > 0) {
        try {
          const current = await ddpCall(ddp, 'jobs.getStatus', API_KEY, job._id);
          if (current === 'failed') {
            log(`Job ${job._id} was cancelled, stopping`);
            return;
          }
        } catch { /* continue if can't check */ }
      }

      // Report progress
      try {
        await ddpCall(ddp, 'jobs.updateProgress', API_KEY, job._id, i, scenario);
      } catch { /* non-critical */ }

      const resultPath = runBenchmark(scenario, job.branch);
      log(`Result: ${resultPath}`);

      // Read result and push via DDP directly (with retry)
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      const runId = await ddpCall(ddp, 'runs.insert', API_KEY, result);
      runIds.push(runId);
      log(`Pushed run ${runId} for ${scenario}`);
    }

    await ddpCall(ddp, 'jobs.markDone', API_KEY, job._id, runIds);
    log(`=== Job ${job._id} completed: ${runIds.length} runs pushed`);
  } catch (err) {
    const errorMsg = err.message?.slice(0, MAX_LOG_LENGTH) || 'Unknown error';
    log(`=== Job ${job._id} failed: ${errorMsg}`);
    try {
      await ddpCall(ddp, 'jobs.markFailed', API_KEY, job._id, errorMsg);
    } catch (markErr) {
      log(`Failed to mark job as failed: ${markErr.message}`);
    }
  }
}

function fetchBranches() {
  try {
    const raw = execSync('git branch -r --sort=-committerdate', {
      cwd: METEOR_CHECKOUT, encoding: 'utf8',
    });
    return raw.split('\n')
      .map((b) => b.trim().replace('origin/', ''))
      .filter((b) => b && !b.includes('HEAD') && !b.includes(' -> '));
  } catch {
    return [];
  }
}

async function syncBranches(ddp) {
  try {
    execSync('git fetch origin --prune', { cwd: METEOR_CHECKOUT, stdio: 'pipe' });
    const branches = fetchBranches();
    if (branches.length > 0) {
      await ddpCall(ddp, 'jobs.updateBranches', API_KEY, branches);
      log(`Synced ${branches.length} branches to dashboard`);
    }
  } catch (err) {
    log(`Branch sync error: ${err.message}`);
  }
}

async function main() {
  log('Bench agent starting...');
  log(`Dashboard: ${DASHBOARD_URL}`);
  log(`Meteor checkout: ${METEOR_CHECKOUT}`);

  const ddp = await createDDP();

  ddp.on('disconnected', () => {
    log('Disconnected from dashboard, will reconnect...');
  });
  ddp.on('connected', () => {
    log('Reconnected to dashboard');
  });

  // Sync branches on startup
  await syncBranches(ddp);

  let pollCount = 0;
  while (true) {
    try {
      // Heartbeat
      await ddpCall(ddp, 'jobs.heartbeat', API_KEY);

      // Claim next pending job
      const job = await ddpCall(ddp, 'jobs.claimNext', API_KEY);

      if (job) {
        await executeJob(ddp, job);
        // Check for more jobs immediately
        continue;
      }
    } catch (err) {
      log(`Poll error: ${err.message}`);
    }

    // Re-sync branches every ~10 minutes (20 polls × 30s)
    pollCount++;
    if (pollCount % 20 === 0) {
      await syncBranches(ddp);
    }

    await sleep(POLL_INTERVAL);
  }
}

main().catch((err) => {
  console.error('Agent fatal error:', err);
  process.exit(1);
});
