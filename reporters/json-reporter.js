/**
 * JSON Reporter
 *
 * Collects results from all collectors and produces a single JSON file
 * with metadata (date, Meteor version, git SHA, scenario, app).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Build a result object from collector outputs.
 * @param {Object} options
 * @param {string} options.scenario - Scenario name
 * @param {string} options.app - App name
 * @param {string} options.tag - Version tag (e.g., "v3.5", "devel")
 * @param {Object} options.meteorCheckoutPath - Path to Meteor checkout
 * @param {Object[]} options.collectorResults - Array of parsed JSON from collectors
 * @param {number} options.wallClockMs - Total wall-clock time
 * @param {Object} [options.extraEnv] - Extra env vars passed via --env flags
 * @param {Object} [options.configFlags] - Map of env var → label from bench.config.js
 * @returns {Object} Complete result object
 */
function buildResult({ scenario, app, tag, meteorCheckoutPath, collectorResults, wallClockMs, extraEnv, configFlags }) {
  let meteorVersion = 'unknown';
  let meteorSha = 'unknown';

  if (meteorCheckoutPath) {
    try {
      meteorSha = execSync('git rev-parse --short HEAD', { cwd: meteorCheckoutPath, encoding: 'utf8' }).trim();
      meteorVersion = execSync('git describe --tags --always', { cwd: meteorCheckoutPath, encoding: 'utf8' }).trim();
    } catch {
      // Not a git repo or git not available
    }
  }

  // Build config from env vars matching configFlags
  const config = {};
  if (configFlags && extraEnv) {
    for (const [envVar, label] of Object.entries(configFlags)) {
      if (extraEnv[envVar]) {
        config[label] = envVar === 'MONGO_OPLOG_URL' ? true : extraEnv[envVar];
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    tag: tag || meteorVersion,
    meteor: {
      version: meteorVersion,
      sha: meteorSha,
    },
    scenario,
    app,
    ...(Object.keys(config).length > 0 && { config }),
    wall_clock_ms: wallClockMs,
    metrics: Object.fromEntries(
      collectorResults.map((r) => [r.metric, r])
    ),
  };
}

/**
 * Write result to a JSON file.
 * @param {Object} result - Result from buildResult
 * @param {string} outputPath - Path to write
 */
function writeResult(result, outputPath) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n');
}

/**
 * Append result to history file.
 * @param {Object} result - Result from buildResult
 * @param {string} historyDir - History directory
 */
function appendToHistory(result, historyDir) {
  if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
  const filename = `${result.scenario}-${result.tag}-${Date.now()}.json`;
  writeResult(result, path.join(historyDir, filename));
}

/**
 * Validate a result object. Returns { valid, warnings, errors }.
 * Errors = must not push. Warnings = push but flag.
 */
function validateResult(result) {
  const errors = [];
  const warnings = [];

  // Required fields
  if (!result.tag) errors.push('Missing tag');
  if (!result.scenario) errors.push('Missing scenario');
  if (!result.wall_clock_ms && result.wall_clock_ms !== 0) errors.push('Missing wall_clock_ms');

  // No metrics at all = something went very wrong
  if (!result.metrics || Object.keys(result.metrics).length === 0) {
    errors.push('No metrics collected — app may have crashed');
  }

  // Artillery/script scenarios: check for app resource metrics
  const hasAppResources = !!result.metrics?.app_resources;
  const hasGc = !!result.metrics?.gc;
  if (!hasAppResources && !['cold_start', 'bundle_size'].includes(result.metrics && Object.keys(result.metrics)[0])) {
    warnings.push('No app resource metrics (CPU/RAM) — collector may have failed');
  }
  if (!hasGc && hasAppResources) {
    warnings.push('No GC metrics — GC monitor may not have been injected');
  }

  // Wall clock sanity: if exactly at a round timeout boundary, likely a timeout
  const wallSec = result.wall_clock_ms / 1000;
  const commonTimeouts = [60, 120, 180, 300, 600];
  for (const t of commonTimeouts) {
    if (Math.abs(wallSec - t) < 2) {
      warnings.push(`Wall clock ${wallSec.toFixed(1)}s is suspiciously close to ${t}s timeout`);
      break;
    }
  }

  return { valid: errors.length === 0, warnings, errors };
}

module.exports = { buildResult, writeResult, appendToHistory, validateResult };
