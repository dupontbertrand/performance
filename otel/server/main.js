// Initialize OpenTelemetry FIRST, before any other imports
import { initOtel, createRoundtripTracer } from 'meteor/meteor-otel';

initOtel({
  serviceName: process.env.OTEL_SERVICE_NAME || 'meteor-host',
});

// Now import the rest
import { Meteor } from 'meteor/meteor';
import { LinksCollection } from '/imports/api/links';
import { Random } from 'meteor/random';
import { check } from 'meteor/check';

// Create a roundtrip tracer for the links collection
const linksTracer = createRoundtripTracer('links.roundtrip');

Meteor.startup(async () => {
  console.log('Server started');
  console.log(`MongoDB URL: ${process.env.MONGO_URL}`);
  console.log(`MongoDB Oplog URL: ${process.env.MONGO_OPLOG_URL}`);

  Meteor.publish('links', function () {
    return LinksCollection.find({ scriptRunId: { $exists: false } });
  });

  Meteor.methods({
    async 'links.insert'(traceContext = {}) {
      const { sessionId, createdAt } = traceContext;
      check(sessionId, String);

      const roundtrip = linksTracer.begin('links.insert->publish', {
        'links.sessionId': sessionId,
      });

      let createdAtDate = createdAt;
      if (!(createdAtDate instanceof Date)) {
        createdAtDate = new Date(createdAtDate.$date);
      }
      if (!(createdAtDate instanceof Date) || Number.isNaN(createdAtDate.getTime())) {
        const err = new Meteor.Error(
          'invalid-createdAt',
          'createdAt must be a valid Date supplied by the client'
        );
        roundtrip.fail(err);
        throw err;
      }

      const doc = {
        _id: Random.id(),
        createdAt: new Date(createdAtDate.getTime()),
        sessionId,
      };

      roundtrip.trackDocument('links', doc._id);

      try {
        await roundtrip.run(() => LinksCollection.insertAsync(doc));
        return doc._id;
      } catch (error) {
        roundtrip.fail(error);
        throw error;
      }
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

process.on('SIGINT', () => {
  console.log('LinksObservable stopped. Summary:', summary);
  process.exit();
});
