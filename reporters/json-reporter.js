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

module.exports = { buildResult, writeResult, appendToHistory };
