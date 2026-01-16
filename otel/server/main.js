// Initialize OpenTelemetry FIRST, before any other imports
import { initOtel, withSpan } from 'meteor/meteor-otel';

initOtel({
  serviceName: process.env.OTEL_SERVICE_NAME || 'meteor-host',
});

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

      await withSpan('links.insert', 'FfirstSpan312', async () => {
        //wait 1s
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }, { attributes: { 'links.sessionId': sessionId } });
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
  },
});

process.on('SIGINT', () => {
  console.log('LinksObservable stopped. Summary:', summary);
  process.exit();
});
