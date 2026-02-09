import os from 'node:os';
import { initOtel } from 'meteor/meteor-otel';

import { Meteor } from 'meteor/meteor';
import { LinksCollection } from '/imports/api/links';
import { Random } from 'meteor/random';
import { check } from 'meteor/check';

Meteor.startup(async () => {
  console.log('Server started');
  console.log(`MongoDB URL: ${process.env.MONGO_URL}`);
  console.log(`MongoDB Oplog URL: ${process.env.MONGO_OPLOG_URL}`);

  initOtel({
    serviceName: process.env.OTEL_SERVICE_NAME || 'meteor-host',
    resourceAttributes: {
      'deployment.environment': process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || 'development',
      'service.namespace': process.env.OTEL_SERVICE_NAMESPACE || 'meteor-apps',
      'service.version': process.env.OTEL_SERVICE_VERSION || process.env.npm_package_version || '0.0.0',
      'service.instance.id': `${os.hostname()}-${process.pid}`,
    }
  });
  
  await LinksCollection.removeAsync({});

  Meteor.publish('links', function () {
    return LinksCollection.find({ scriptRunId: { $exists: false } });
  });

  Meteor.methods({
    async 'links.insert'(traceContext = {}) {
      const { sessionId, createdAt } = traceContext;
      check(sessionId, String);

      let createdAtDate = new Date(createdAt);

      const doc = {
        _id: Random.id(),
        createdAt: new Date(createdAtDate.getTime()),
        sessionId,
      };

      await LinksCollection.insertAsync(doc)
      return doc._id;
     
    },
    async 'links.clear'() {
      await LinksCollection.removeAsync({});
    },
    async 'links.clearSession'(sessionId) {
      check(sessionId, String);
      await LinksCollection.removeAsync({ sessionId });
    },
  });
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
  },
});

process.on('SIGINT', async () => {
  console.log('Memory peaks (GB):', Object.fromEntries(
    Object.entries(memoryPeaks).map(([key, value]) => [key, Math.round((value / 1024 / 1024 / 1024) * 100) / 100])
  ));
  process.exit();
});


