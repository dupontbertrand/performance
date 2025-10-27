#!/usr/bin/env node

import cluster from 'node:cluster';
import os from 'node:os';
import { MongoClient, ObjectId } from 'mongodb';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const args = process.argv.slice(2);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const meteorSettingsPath = resolve(__dirname, '..', 'settings.json');

function readArg(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    return undefined;
  }
  return args[index + 1];
}

function parseInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseDuration(value, fallbackMs) {
  if (value === undefined || value === null) return fallbackMs;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  const str = String(value).trim();
  // accepts: 500ms, 30s, 2m, 1.5h, or just a number (defaults to seconds)
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(str);
  if (!match) return fallbackMs;
  const num = Number.parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  const unitMs = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000; // h
  return Math.max(0, Math.round(num * unitMs));
}

function inferDbName(uri) {
  const questionMark = uri.indexOf('?');
  const sanitized = questionMark === -1 ? uri : uri.slice(0, questionMark);
  const lastSlash = sanitized.lastIndexOf('/');
  if (lastSlash === -1) {
    return undefined;
  }
  const candidate = sanitized.slice(lastSlash + 1);
  if (candidate.includes(',')) {
    return undefined;
  }
  return candidate || undefined;
}

function loadMeteorSettings() {
  try {
    const content = readFileSync(meteorSettingsPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Unable to read settings.json: ${error.message}`);
    return null;
  }
}

const meteorSettings = loadMeteorSettings();
const reactivityOptions = meteorSettings?.packages?.mongo?.reactivity ?? null;

const mongoUrl =
  readArg('--mongo') ??
  process.env.MONGO_URL ??
  'mongodb://127.0.0.1:27017/perf-metrics';

const CONFIG = {
  mongoUrl,
  dbName:
    readArg('--db') ??
    process.env.MONGO_DB_NAME ??
    inferDbName(mongoUrl) ??
    'perf-metrics',
  // Deprecated: prefer duration-based execution
  insertCount: parseInteger(readArg('--insert-count'), 100000),
  bulkSize: parseInteger(readArg('--bulk-size'), 20),
  collectionName: readArg('--collection') ?? 'links',
  durationMs: parseDuration(
    readArg('--duration') ?? process.env.LINK_OPS_DURATION,
    30_000,
  ),
  workers: Math.max(
    1,
    parseInteger(
      readArg('--workers') ?? process.env.LINK_OPS_WORKERS,
      Math.min(os.cpus()?.length ?? 1, 4),
    ),
  ),
};


async function runWorker(workerId) {
  console.log(
    `[worker ${workerId}] Running workload for collection "${CONFIG.collectionName}"`,
  );
  console.log(`[worker ${workerId}] config: ${JSON.stringify(CONFIG)}`);
  if (meteorSettings) {
    if (reactivityOptions) {
      console.log(
        `[worker ${workerId}] Reactivity options from ${meteorSettingsPath}: ${JSON.stringify(
          reactivityOptions,
        )}`,
      );
    } else {
      console.log(`[worker ${workerId}] Reactivity options not specified in ${meteorSettingsPath}`);
    }
  } else {
    console.log(`[worker ${workerId}] Meteor settings file not found at ${meteorSettingsPath}`);
  }

  const client = new MongoClient(CONFIG.mongoUrl, {
    maxPoolSize: 20,
    retryWrites: true,
    appName: 'perf-metrics-script',
  });

  const scriptRunId = `${randomUUID()}-w${workerId}`;

  try {
    await client.connect();
    const db = client.db(CONFIG.dbName);
    const links = db.collection(CONFIG.collectionName);

    const start = Date.now();
    const deadline = start + Math.max(1, CONFIG.durationMs);
    const chunkSize = Math.max(1, CONFIG.bulkSize);

    let insertedTotal = 0;
    let updatedTotal = 0;
    let deletedTotal = 0;
    let cycles = 0;

    console.log(
      `[worker ${workerId}] Running time-based workload for ~${CONFIG.durationMs}ms (chunkSize=${chunkSize})...`,
    );

    while (Date.now() < deadline) {
      const now = new Date();
      const docs = Array.from({ length: chunkSize }, (_, index) => ({
        scriptRunId,
        createdAt: now,
        status: 'inserted',
        label: `script-link-${cycles + 1}-${index + 1}`,
        externalRef: new ObjectId().toHexString(),
        scriptMetrics: {
          cycle: cycles + 1,
          insertIndex: index,
          insertedAtIso: now.toISOString(),
        },
      }));

      // Insert a chunk
      const insertResult = await links.insertMany(docs, { ordered: false });
      const ids = Object.values(insertResult.insertedIds);
      insertedTotal += ids.length;

      // Update each
      for (let i = 0; i < ids.length; i += 1) {
        const targetId = ids[i];
        const updateTimestamp = new Date();
        await links.updateOne(
          { _id: targetId },
          {
            $set: {
              status: 'updated',
              updatedAt: updateTimestamp,
              'scriptMetrics.lastUpdateAtIso': updateTimestamp.toISOString(),
              'scriptMetrics.lastUpdateSequence': i + 1,
            },
            $inc: {
              'scriptMetrics.updateCount': 1,
            },
          },
        );
        updatedTotal += 1;
      }

      // Delete the chunk
      await links.deleteMany({ _id: { $in: ids } });
      deletedTotal += ids.length;

      cycles += 1;

      if (cycles % 10 === 0) {
        console.log(
          `[worker ${workerId}] progress cycles=${cycles} inserted=${insertedTotal} updated=${updatedTotal} deleted=${deletedTotal}`,
        );
      }
    }

    // Best-effort cleanup in case of any leftovers for this run
    const leftover = await links.deleteMany({ scriptRunId });
    if (leftover.deletedCount > 0) {
      console.log(
        `[worker ${workerId}] cleanup removed ${leftover.deletedCount} leftover docs for run ${scriptRunId}`,
      );
    }

    const remainingCount = await links.countDocuments({ scriptRunId });
    const elapsedMs = Date.now() - start;

    const summary = {
      runId: scriptRunId,
      mode: 'time',
      durationMs: CONFIG.durationMs,
      elapsedMs,
      cycles,
      inserted: insertedTotal,
      updates: updatedTotal,
      deleted: deletedTotal,
      remaining: remainingCount,
    };

    console.log(`[worker ${workerId}] workload complete: ${JSON.stringify(summary)}`);
    if (typeof process.send === 'function') {
      process.send({ type: 'result', workerId, summary });
    }
    return summary;
  } catch (error) {
    console.error(`[worker ${workerId}] Script failed:`, error);
    if (typeof process.send === 'function') {
      process.send({ type: 'error', workerId, message: error?.message ?? 'unknown error' });
    }
    process.exitCode = 1;
    throw error;
  } finally {
    await client.close();
  }
}

async function runPrimary() {
  const { workers } = CONFIG;
  console.log(
    `[primary ${process.pid}] launching ${workers} worker${workers === 1 ? '' : 's'} for collection "${CONFIG.collectionName}"`,
  );

  let failures = 0;

  return new Promise((resolve) => {
    cluster.on('message', (_worker, message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'result') {
        console.log(
          `[primary] received summary from worker ${message.workerId}: ${JSON.stringify(
            message.summary,
          )}`,
        );
      } else if (message.type === 'error') {
        failures += 1;
        console.error(
          `[primary] worker ${message.workerId} reported error: ${message.message}`,
        );
      }
    });

    let exited = 0;
    cluster.on('exit', (worker, code, signal) => {
      exited += 1;
      if (code !== 0) {
        failures += 1;
        console.error(
          `[primary] worker ${worker.id} exited with code ${code} signal ${signal ?? 'none'}`,
        );
      } else {
        console.log(`[primary] worker ${worker.id} exited cleanly`);
      }
      if (exited === workers) {
        if (failures > 0) {
          process.exitCode = 1;
        }
        resolve();
      }
    });

    for (let i = 0; i < workers; i += 1) {
      cluster.fork({ LINK_OPS_WORKER_ID: String(i + 1) });
    }
  });
}

async function main() {
  console.log(`[main ${process.pid}] Starting mongo-links-ops script`);
  console.log(`[main ${process.pid}] Configuration: ${JSON.stringify(CONFIG)}`);
  if (cluster.isPrimary) {
    await runPrimary();
  } else {
    const workerId =
      Number.parseInt(process.env.LINK_OPS_WORKER_ID ?? '', 10) ||
      cluster.worker?.id ||
      0;
    try {
      await runWorker(workerId);
    } catch (error) {
      console.error(`[worker ${workerId}] terminating due to error`);
      process.exit(1);
    }
  }
}

main();
