# Meteor Performance

Automated benchmark framework for detecting performance regressions across Meteor releases.

**Live Dashboard**: [meteor-benchmark-dashboard.sandbox.galaxycloud.app](https://meteor-benchmark-dashboard.sandbox.galaxycloud.app)

## What it does

- Benchmarks Meteor apps under load (Artillery + Playwright + DDP-raw)
- Collects CPU, RAM, and GC metrics from the Meteor process
- Compares two branches/releases and detects regressions
- Pushes results to a live Blaze dashboard on Galaxy
- Runs automatically via GitHub Actions (PR checks, nightly, transport comparison)

## Quick start

```bash
# Install dependencies
npm install
npx playwright install chromium

# Install app dependencies
cd apps/tasks-3.x && npm install && cd ../..

# Run a benchmark (uses system Meteor)
node bench.js run --scenario reactive-light --tag my-test

# Run against a local Meteor checkout
METEOR_CHECKOUT_PATH=/path/to/meteor/checkout \
  node bench.js run --scenario reactive-light --tag devel

# Compare two results
node bench.js compare --baseline results/a.json --target results/b.json

# List available scenarios
node bench.js list
```

## CLI commands

| Command | Description |
|---------|-------------|
| `bench.js run` | Run a benchmark scenario |
| `bench.js compare` | Compare two result files |
| `bench.js push` | Push results to the Galaxy dashboard |
| `bench.js list` | List available scenarios and apps |

### `run` options

| Flag | Description | Default |
|------|-------------|---------|
| `--scenario` | Scenario to run | `reactive-light` |
| `--tag` | Label for this run (branch name, version) | required |
| `--output` | Output JSON file path | auto-generated |
| `--app` | App directory to benchmark | `tasks-3.x` |
| `--env` | Environment variable for Meteor process (e.g. `DDP_TRANSPORT=uws`) | none |
| `--runs` | Number of runs for cold-start (takes median) | `3` |

## Scenarios

### Reactive pub/sub (browser)

| Scenario | VUs | Duration | What it tests |
|----------|-----|----------|---------------|
| `reactive-light` | 30 browsers | ~2 min | Full-stack reactive CRUD (light load) |
| `reactive-crud` | 240 browsers | ~5 min | Full-stack reactive CRUD (heavy load) |
| `non-reactive-crud` | 240 browsers | ~5 min | Methods-only CRUD (no reactivity) |

### DDP server (no browser)

| Scenario | VUs | Duration | What it tests |
|----------|-----|----------|---------------|
| `ddp-reactive-light` | 150 DDP clients | ~30s | Server-side DDP throughput with pub/sub |
| `ddp-non-reactive-light` | 150 DDP clients | ~30s | Server-side methods-only throughput |

### Reactive fanout

| Scenario | Subscribers | Duration | What it tests |
|----------|-------------|----------|---------------|
| `fanout-light` | 50 | ~15s | Reactive propagation latency (1 writer → N subscribers) |
| `fanout-heavy` | 200 | ~30s | Reactive propagation at scale |

### Cold start / Build

| Scenario | Duration | What it tests |
|----------|----------|---------------|
| `cold-start` | ~1 min | `meteor reset` → app running (median of 3 runs) |
| `bundle-size` | ~30s | Client JS + server bundle size after `meteor build` |

## Transport comparison

Compare WebSocket transports on branches with pluggable transport support:

```bash
node bench.js run --scenario ddp-reactive-light --tag sockjs \
  --env DDP_TRANSPORT=sockjs --output results/sockjs.json

node bench.js run --scenario ddp-reactive-light --tag uws \
  --env DDP_TRANSPORT=uws --output results/uws.json

node bench.js compare --baseline results/sockjs.json --target results/uws.json
```

## Metrics collected

| Metric | Source | Description |
|--------|--------|-------------|
| Wall clock | Timer | Total benchmark duration |
| APP CPU avg/max | pidusage | Meteor process CPU usage |
| APP RAM avg/max | pidusage | Meteor process memory |
| DB CPU/RAM | pidusage | MongoDB process resources |
| GC total pause | perf_hooks | Total garbage collection pause time |
| GC max pause | perf_hooks | Longest single GC pause |
| GC count | perf_hooks | Number of GC events |
| GC major | perf_hooks | Full (mark-sweep-compact) GC time |
| Fanout p50/p95/max | SimpleDDP | Reactive propagation latency |
| Startup time | Timer | Cold start duration (median) |
| Bundle size | du | Client JS + server bundle in KB |

## CI / GitHub Actions

### PR Benchmark (on demand)

```bash
gh workflow run benchmark-pr.yml \
  -f branch=devel \
  -f baseline=release-3.5 \
  -f scenario=reactive-light
```

### Transport Benchmark (on demand)

Runs the same scenario with `DDP_TRANSPORT=sockjs` and `DDP_TRANSPORT=uws` in parallel:

```bash
gh workflow run benchmark-transport.yml \
  -f branch=release-3.5 \
  -f scenario=ddp-reactive-light
```

### Nightly Benchmark (cron)

Runs every night at 3am UTC on `devel` vs the latest release branch.

## Dashboard

Deployed separately: [dupontbertrand/meteor-benchmark-dashboard](https://github.com/dupontbertrand/meteor-benchmark-dashboard)

- **Release Health** — Diagnosis cockpit: verdict, fingerprint, top regressions/improvements
- **Compare** — Side-by-side comparison with relative deltas
- **Trends** — Historical charts with range filtering
- **Scenario Detail** — Technical description per scenario
- **About** — Methodology documentation

## Project structure

```
bench.js                  CLI entry point
bench.config.js           Scenarios, thresholds, config
collectors/
  process-monitor.js      CPU/RAM collector (pidusage)
  gc-monitor.js           GC collector (perf_hooks)
  event-loop-monitor.js   Event loop delay histogram
reporters/
  json-reporter.js        JSON output
  regression-detector.js  Comparison + regression detection
artillery/
  reactive-stress.yml         240 browser VUs
  reactive-stress-light.yml   30 browser VUs
  non-reactive-stress.yml     240 browser VUs, methods only
  ddp-reactive-light.yml      150 DDP clients, reactive
  ddp-non-reactive-light.yml  150 DDP clients, methods only
tests/
  test-helpers.js         Playwright test functions
  ddp-helpers.js          SimpleDDP scenario functions
  fanout-bench.js         Fanout latency benchmark
apps/
  tasks-3.x/              Meteor 3 React benchmark app
  tasks-2.x/              Meteor 2 React benchmark app
.github/workflows/
  benchmark-pr.yml        PR benchmark workflow
  benchmark-nightly.yml   Nightly benchmark workflow
  benchmark-transport.yml Transport comparison workflow
```

## Requirements

- Node.js >= 20
- Chromium (installed via Playwright)
- A Meteor checkout (for comparing branches)

## Legacy

The original runtime and bundler benchmark docs are still available:
- [Runtime benchmarking](./RUNTIME.md)
- [Bundler benchmarking](./BUNDLER.md)
