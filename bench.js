#!/usr/bin/env node

/**
 * Meteor Benchmark Framework — CLI
 *
 * Usage:
 *   node bench.js run [--scenario <name>] [--app <name>] [--tag <label>]
 *   node bench.js compare --baseline <file> --target <file> [--format markdown|json]
 *   node bench.js list
 *
 * For version comparison:
 *   1. cd $METEOR_CHECKOUT_PATH && git checkout release/3.5
 *   2. node bench.js run --tag v3.5 --output results/v3.5.json
 *   3. cd $METEOR_CHECKOUT_PATH && git checkout devel
 *   4. node bench.js run --tag devel --output results/devel.json
 *   5. node bench.js compare --baseline results/v3.5.json --target results/devel.json
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const minimist = require('minimist');
const config = require('./bench.config');
const { buildResult, writeResult, appendToHistory } = require('./reporters/json-reporter');
const { compare, toMarkdown } = require('./reporters/regression-detector');

const args = minimist(process.argv.slice(2));
const command = args._[0];

function getMeteorCmd() {
  if (config.meteorCheckoutPath && fs.existsSync(path.join(config.meteorCheckoutPath, 'meteor'))) {
    return path.join(config.meteorCheckoutPath, 'meteor');
  }
  return 'meteor';
}

function getMeteorInfo() {
  const meteorPath = config.meteorCheckoutPath;
  if (!meteorPath) return { version: 'system', sha: 'unknown' };
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: meteorPath, encoding: 'utf8' }).trim();
    const branch = execSync('git branch --show-current', { cwd: meteorPath, encoding: 'utf8' }).trim();
    return { version: branch, sha };
  } catch {
    return { version: 'unknown', sha: 'unknown' };
  }
}

function waitForApp(port, timeoutSec = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    try {
      execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}`, { encoding: 'utf8' });
      return true;
    } catch {
      execSync('sleep 1');
    }
  }
  throw new Error(`App did not start within ${timeoutSec}s`);
}

function getPid(pattern) {
  try {
    return execSync(`pgrep -f "${pattern}"`, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

// ─── Commands ────────────────────────────────────────────────────────

function cmdList() {
  console.log('\nAvailable scenarios:');
  for (const [name, s] of Object.entries(config.scenarios)) {
    console.log(`  ${name.padEnd(20)} ${s.description}`);
  }
  console.log('\nAvailable apps:');
  for (const [name, a] of Object.entries(config.apps)) {
    console.log(`  ${name.padEnd(20)} ${a.description}`);
  }
  console.log(`\nMeteor checkout: ${config.meteorCheckoutPath}`);
  const info = getMeteorInfo();
  console.log(`  Branch: ${info.version}  SHA: ${info.sha}\n`);
}

async function cmdRun() {
  const scenarioName = args.scenario || 'reactive-crud';
  const appName = args.app || config.defaultApp;
  const tag = args.tag || getMeteorInfo().version;
  const outputPath = args.output || path.join(config.results.dir, `${scenarioName}-${tag}-${Date.now()}.json`);

  const scenario = config.scenarios[scenarioName];
  const app = config.apps[appName];
  if (!scenario) { console.error(`Unknown scenario: ${scenarioName}`); process.exit(1); }
  if (!app) { console.error(`Unknown app: ${appName}`); process.exit(1); }

  const info = getMeteorInfo();
  console.log(`\n🔧 Benchmark: ${scenarioName}`);
  console.log(`   App: ${appName}`);
  console.log(`   Meteor: ${info.version} (${info.sha})`);
  console.log(`   Tag: ${tag}\n`);

  if (scenario.driver === 'cli') {
    console.log(`CLI scenario "${scenarioName}" — not yet implemented.`);
    console.log('This will measure cold-start, hot-reload, or bundle-size.');
    process.exit(0);
  }

  // Install app npm deps if needed
  const nodeModulesPath = path.join(app.path, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('Installing app npm dependencies...');
    execSync('npm install', { cwd: app.path, stdio: 'inherit' });
  }

  // Clean and start Meteor app
  const meteorCmd = getMeteorCmd();
  console.log('Cleaning app state...');
  execSync(`${meteorCmd} reset`, { cwd: app.path, stdio: 'inherit' });

  // GC monitor: inject into Meteor's server process via SERVER_NODE_OPTIONS
  const gcMonitorPath = path.resolve(__dirname, 'collectors/gc-monitor.js');
  const resultsDir = path.resolve(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
  const gcOutputPath = path.join(resultsDir, `gc-${tag}-${Date.now()}.json`);
  const serverNodeOptions = `--require ${gcMonitorPath}`;
  console.log(`GC monitor: ${gcMonitorPath}`);
  console.log(`GC output: ${gcOutputPath}`);

  console.log(`Starting Meteor app (with GC monitor)...`);
  console.log(`SERVER_NODE_OPTIONS=${serverNodeOptions}`);
  const meteorProc = spawn(meteorCmd, ['run', '--port', String(config.appPort)], {
    cwd: app.path,
    env: {
      ...process.env,
      METEOR_PACKAGE_DIRS: path.resolve(__dirname, 'packages'),
      SERVER_NODE_OPTIONS: serverNodeOptions,
      GC_MONITOR_OUTPUT: gcOutputPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Log meteor output to stderr
  meteorProc.stdout.on('data', (d) => process.stderr.write(d));
  meteorProc.stderr.on('data', (d) => process.stderr.write(d));

  console.log('Waiting for app to start...');
  const startTime = Date.now();
  waitForApp(config.appPort);
  const startupMs = Date.now() - startTime;
  console.log(`App started in ${(startupMs / 1000).toFixed(1)}s`);

  // Start collectors
  const collectorProcs = [];
  const collectorResults = [];

  // Process monitor for app
  const appPid = getPid(`${appName}/.meteor/local/build/main.js`);
  if (appPid) {
    const proc = spawn('node', [path.resolve(__dirname, 'collectors/process-monitor.js'), appPid, 'APP'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    collectorProcs.push({ proc, getResult: () => stdout });
  }

  // Process monitor for MongoDB
  const dbPid = getPid(`${appName}/.meteor/local/db`);
  if (dbPid) {
    const proc = spawn('node', [path.resolve(__dirname, 'collectors/process-monitor.js'), dbPid, 'DB'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    collectorProcs.push({ proc, getResult: () => stdout });
  }

  // Run Artillery
  console.log(`\nRunning Artillery: ${scenario.config}...`);
  const artilleryStart = Date.now();
  try {
    execSync(`npx artillery run "${path.resolve(__dirname, scenario.config)}"`, {
      cwd: __dirname,
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (err) {
    console.error('Artillery failed:', err.message);
  }
  const wallClockMs = Date.now() - artilleryStart;

  // Stop collectors and gather results
  for (const { proc, getResult } of collectorProcs) {
    proc.kill('SIGTERM');
    // Give collector time to output
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const raw = getResult().trim();
    if (raw) {
      try { collectorResults.push(JSON.parse(raw)); } catch {}
    }
  }

  // Stop Meteor (SIGTERM triggers gc-monitor output)
  meteorProc.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Collect GC metrics from output file
  if (fs.existsSync(gcOutputPath)) {
    try {
      const gcData = JSON.parse(fs.readFileSync(gcOutputPath, 'utf8'));
      collectorResults.push(gcData);
      console.log(`GC: ${gcData.count} collections, ${gcData.total_pause_ms}ms total pause, ${gcData.max_pause_ms}ms max`);
      console.log(`  Minor: ${gcData.minor.count} (${gcData.minor.total_ms}ms) | Major: ${gcData.major.count} (${gcData.major.total_ms}ms)`);
      fs.unlinkSync(gcOutputPath); // cleanup temp file
    } catch (err) {
      console.error('Could not read GC metrics:', err.message);
    }
  } else {
    console.log(`GC metrics not collected — file not found: ${gcOutputPath}`);
    // List results dir to debug
    try {
      const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('gc-'));
      if (files.length > 0) console.log(`  Found GC files: ${files.join(', ')}`);
    } catch {}
  }

  // Build and write result
  const result = buildResult({
    scenario: scenarioName,
    app: appName,
    tag,
    meteorCheckoutPath: config.meteorCheckoutPath,
    collectorResults,
    wallClockMs,
  });

  writeResult(result, outputPath);
  appendToHistory(result, config.results.history);
  console.log(`\nResults written to: ${outputPath}`);
  console.log(`Wall clock: ${(wallClockMs / 1000).toFixed(1)}s`);

  for (const r of collectorResults) {
    if (r.cpu) console.log(`${r.name} CPU: avg ${r.cpu.avg}% max ${r.cpu.max}%`);
    if (r.memory) console.log(`${r.name} RAM: avg ${r.memory.avg_mb}MB max ${r.memory.max_mb}MB`);
  }
}

function cmdCompare() {
  const baselinePath = args.baseline;
  const targetPath = args.target;
  const format = args.format || 'markdown';

  if (!baselinePath || !targetPath) {
    console.error('Usage: node bench.js compare --baseline <file> --target <file>');
    process.exit(1);
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  const report = compare(baseline, target);

  if (format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(toMarkdown(report));
  }

  process.exit(report.summary.passed ? 0 : 1);
}

async function cmdPush() {
  const resultPath = args.result;
  const url = args.url || config.dashboardUrl || 'ws://localhost:4000/websocket';
  const apiKey = args.key || process.env.BENCH_API_KEY || config.dashboardApiKey || 'dev-bench-key-change-in-prod';

  if (!resultPath) {
    console.error('Usage: node bench.js push --result <file.json> [--url <ws-url>] [--key <api-key>]');
    process.exit(1);
  }

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  console.log(`Pushing ${resultPath} to ${url}...`);

  const SimpleDDP = require('simpleddp');
  const ws = require('ws');

  const ddp = new SimpleDDP({
    endpoint: url,
    SocketConstructor: ws,
    reconnectInterval: 5000,
  });

  try {
    await ddp.connect();
    const docId = await ddp.call('runs.insert', apiKey, result);
    console.log(`Pushed successfully. Document ID: ${docId}`);
  } catch (err) {
    console.error('Push failed:', err.message || err);
    process.exit(1);
  } finally {
    ddp.disconnect();
  }
}

async function cmdBaseline() {
  const scenario = args.scenario;
  const runId = args['run-id'] || args.runId;
  const url = args.url || config.dashboardUrl || 'ws://localhost:4000/websocket';
  const apiKey = args.key || process.env.BENCH_API_KEY || config.dashboardApiKey || 'dev-bench-key-change-in-prod';

  if (!scenario || !runId) {
    console.error('Usage: node bench.js baseline --scenario <name> --run-id <id> [--url <ws-url>]');
    process.exit(1);
  }

  console.log(`Setting baseline for "${scenario}" to run ${runId}...`);

  const SimpleDDP = require('simpleddp');
  const ws = require('ws');

  const ddp = new SimpleDDP({
    endpoint: url,
    SocketConstructor: ws,
    reconnectInterval: 5000,
  });

  try {
    await ddp.connect();
    await ddp.call('baselines.set', apiKey, scenario, runId);
    console.log('Baseline set successfully.');
  } catch (err) {
    console.error('Failed:', err.message || err);
    process.exit(1);
  } finally {
    ddp.disconnect();
  }
}

// ─── Main ────────────────────────────────────────────────────────────

switch (command) {
  case 'list':
    cmdList();
    break;
  case 'run':
    cmdRun().catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'compare':
    cmdCompare();
    break;
  case 'push':
    cmdPush().catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'baseline':
    cmdBaseline().catch((err) => { console.error(err); process.exit(1); });
    break;
  default:
    console.log(`
Meteor Benchmark Framework

Usage:
  node bench.js list                                    List scenarios and apps
  node bench.js run [--scenario X] [--app Y] [--tag Z]  Run a benchmark
  node bench.js compare --baseline A --target B          Compare two results
  node bench.js push --result <file.json> [--url <ws>]   Push results to dashboard
  node bench.js baseline --scenario X --run-id Y         Set baseline for a scenario

Dashboard:
  Default URL: ${config.dashboardUrl || 'ws://localhost:4000/websocket'}
  Set BENCH_API_KEY env var or use --key flag for authentication

Version comparison workflow:
  cd ${config.meteorCheckoutPath} && git checkout release/3.5
  node bench.js run --tag v3.5 --output results/v3.5.json

  cd ${config.meteorCheckoutPath} && git checkout devel
  node bench.js run --tag devel --output results/devel.json

  node bench.js compare --baseline results/v3.5.json --target results/devel.json
  node bench.js push --result results/devel.json
`);
}
