/**
 * Regression Detector
 *
 * Compares two benchmark result files and flags regressions
 * based on configured thresholds.
 */

const fs = require('fs');
const config = require('../bench.config');

/**
 * Compare two result objects and return a report.
 * @param {Object} baseline - Baseline result (JSON parsed)
 * @param {Object} target - Target result (JSON parsed)
 * @returns {Object} { summary, details[], passed, warnings, failures }
 */
function compare(baseline, target) {
  const details = [];
  let warnings = 0;
  let failures = 0;

  const metricPairs = [
    { key: 'wall_clock_ms', baseVal: baseline.wall_clock_ms, targetVal: target.wall_clock_ms },
  ];

  // Flatten metrics from collectors
  for (const [metricName, metricData] of Object.entries(target.metrics || {})) {
    const baseMetric = (baseline.metrics || {})[metricName];
    if (!baseMetric) continue;

    if (metricData.cpu) {
      metricPairs.push({
        key: 'cpu_avg_percent',
        label: `${metricData.name} CPU avg`,
        baseVal: baseMetric.cpu.avg,
        targetVal: metricData.cpu.avg,
      });
    }
    if (metricData.memory) {
      metricPairs.push({
        key: 'ram_avg_mb',
        label: `${metricData.name} RAM avg`,
        baseVal: baseMetric.memory.avg_mb,
        targetVal: metricData.memory.avg_mb,
      });
    }
    if (metricData.p99 !== undefined) {
      metricPairs.push({
        key: 'event_loop_p99_ms',
        label: 'Event loop p99',
        baseVal: baseMetric.p99,
        targetVal: metricData.p99,
      });
    }
    // GC metrics
    if (metricData.metric === 'gc' && baseMetric.metric === 'gc') {
      metricPairs.push({
        key: 'gc_total_pause_ms',
        label: 'GC total pause',
        baseVal: baseMetric.total_pause_ms,
        targetVal: metricData.total_pause_ms,
      });
      metricPairs.push({
        key: 'gc_max_pause_ms',
        label: 'GC max pause',
        baseVal: baseMetric.max_pause_ms,
        targetVal: metricData.max_pause_ms,
      });
      metricPairs.push({
        key: 'gc_count',
        label: 'GC count',
        baseVal: baseMetric.count,
        targetVal: metricData.count,
      });
      metricPairs.push({
        key: 'gc_major_ms',
        label: 'GC major (full)',
        baseVal: baseMetric.major.total_ms,
        targetVal: metricData.major.total_ms,
      });
    }
  }

  for (const { key, label, baseVal, targetVal } of metricPairs) {
    if (baseVal == null || targetVal == null || baseVal === 0) continue;

    const delta = ((targetVal - baseVal) / baseVal) * 100;
    const threshold = config.thresholds[key];
    let status = 'ok';

    if (threshold) {
      if (delta > threshold.fail) {
        status = 'FAIL';
        failures++;
      } else if (delta > threshold.warn) {
        status = 'WARN';
        warnings++;
      }
    }

    details.push({
      metric: label || key,
      baseline: baseVal,
      target: targetVal,
      delta: +delta.toFixed(2),
      status,
    });
  }

  return {
    summary: {
      baseline_tag: baseline.tag,
      target_tag: target.tag,
      scenario: target.scenario,
      passed: failures === 0,
      warnings,
      failures,
    },
    details,
  };
}

/**
 * Format report as markdown table.
 * @param {Object} report - From compare()
 * @returns {string} Markdown string
 */
function toMarkdown(report) {
  const { summary, details } = report;
  const icon = summary.passed ? (summary.warnings > 0 ? '⚠️' : '✅') : '❌';

  let md = `## ${icon} Benchmark: ${summary.scenario}\n\n`;
  md += `**${summary.baseline_tag}** → **${summary.target_tag}**\n\n`;
  md += `| Metric | Baseline | Target | Delta | Status |\n`;
  md += `|--------|----------|--------|-------|--------|\n`;

  for (const d of details) {
    const deltaStr = d.delta > 0 ? `+${d.delta}%` : `${d.delta}%`;
    const statusIcon = d.status === 'FAIL' ? '❌' : d.status === 'WARN' ? '⚠️' : '✅';
    md += `| ${d.metric} | ${d.baseline} | ${d.target} | ${deltaStr} | ${statusIcon} |\n`;
  }

  if (summary.failures > 0) {
    md += `\n**${summary.failures} regression(s) detected.** Performance threshold exceeded.\n`;
  }

  return md;
}

/**
 * CLI: node regression-detector.js <baseline.json> <target.json> [--format markdown|json]
 */
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node regression-detector.js <baseline.json> <target.json> [--format markdown|json]');
    process.exit(1);
  }

  const baseline = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const target = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'markdown';
  const report = compare(baseline, target);

  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(toMarkdown(report));
  }

  process.exit(report.summary.passed ? 0 : 1);
}

module.exports = { compare, toMarkdown };
