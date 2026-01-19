// Initialize OpenTelemetry FIRST, before any other imports
import os from 'node:os';
import { initOtel, withSpan, addEvent, createMetricsRecorder } from 'meteor/meteor-otel';

// Initialize OpenTelemetry
initOtel({
  serviceName: process.env.OTEL_SERVICE_NAME || 'meteor-host',
  resourceAttributes: {
    'deployment.environment': process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || 'development',
    'service.namespace': process.env.OTEL_SERVICE_NAMESPACE || 'meteor-apps',
    'service.version': process.env.OTEL_SERVICE_VERSION || process.env.npm_package_version || '0.0.0',
    'service.instance.id': `${os.hostname()}-${process.pid}`,
  }
});

// Create the Metrics Recorder
const appMetrics = createMetricsRecorder('links-app');

// Counter - counts how many links were created
const linksCreatedCounter = appMetrics.counter(
  'links.created',
  'Number of links created',
  'links'
);

// Histogram - measures insertion latency
const insertLatencyHistogram = appMetrics.histogram(
  'links.insert.latency',
  'Latency of link insertion',
  'ms'
);

// UpDownCounter - counts active links (can go up or down)
const activeLinksCounter = appMetrics.upDownCounter(
  'links.active',
  'Number of active links',
  'links'
);

// Now import the rest
import { Meteor } from 'meteor/meteor';
import { LinksCollection } from '/imports/api/links';
import { Random } from 'meteor/random';
import { check } from 'meteor/check';

// Create a roundtrip tracer for the links collection
// const linksTracer = createRoundtripTracer('links.roundtrip');

Meteor.startup(async () => {
  console.log('Server started');
  console.log(`MongoDB URL: ${process.env.MONGO_URL}`);
  console.log(`MongoDB Oplog URL: ${process.env.MONGO_OPLOG_URL}`);

  Meteor.publish('links', function () {
    return LinksCollection.find({ scriptRunId: { $exists: false } });
  }, { otel: true });

  Meteor.methods({
    async 'links.insert'(traceContext = {}) {
      const { sessionId, createdAt } = traceContext;
      check(sessionId, String);

      // Start latency measurement
      const startTime = Date.now();

      // Event: validation start
      addEvent('validation.start', { sessionId });

      await withSpan('links.insert', 'FfirstSpan312', async () => {
        //wait 1s
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }, { attributes: { 'links.sessionId': sessionId } });

      // Event: validation complete
      addEvent('validation.complete', { sessionId, validated: true });

      let createdAtDate = new Date(createdAt);

      const doc = {
        _id: Random.id(),
        createdAt: new Date(createdAtDate.getTime()),
        sessionId,
      };

      await withSpan('links.insert', 'insertInDb123', async () => {
        try {
          await LinksCollection.insertAsync(doc)
        } catch (error) {
            throw error;
        }
      }, { attributes: { 'links.sessionId': sessionId, 'doc': doc } });

      // Record metrics
      const latency = Date.now() - startTime;
      linksCreatedCounter.add(1, { sessionId });
      insertLatencyHistogram.record(latency, { sessionId });
      activeLinksCounter.add(1, { sessionId });

      return doc._id;
     
    },
    async 'links.clear'() {
      await LinksCollection.removeAsync({});
    },
    async 'links.clearSession'(sessionId) {
      check(sessionId, String);
      await LinksCollection.removeAsync({ sessionId });
    },
  }, { otel: true });
});

const summary = {
  addded: 0,
  changed: 0,
  removed: 0,
};

export const LinksObservable = LinksCollection.find().observeChanges({
  added(id, fields) {
    summary.addded += 1;
  },
  changed(id, fields) {
    summary.changed += 1;
  },
  removed(id) {
    summary.removed += 1;
    // Decrement active links counter
    activeLinksCounter.add(-1);
  },
});

process.on('SIGINT', () => {
  console.log('LinksObservable stopped. Summary:', summary);
  process.exit();
});
