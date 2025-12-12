import './otel.js';
import { Meteor } from 'meteor/meteor';
import { LinksCollection } from '/imports/api/links';
import { Random } from 'meteor/random';
import { check } from 'meteor/check';

Meteor.startup(async () => {

  console.log('Server started');
  console.log(`MongoDB URL: ${process.env.MONGO_URL}`);
  console.log(`MongoDB Oplog URL: ${process.env.MONGO_OPLOG_URL}`);

  Meteor.publish("links", function () {
    return LinksCollection.find({ scriptRunId: { $exists: false } });
  });

  Meteor.methods({
    async "links.insert"(traceContext = {}) {
      const { sessionId, createdAt } = traceContext;
      check(sessionId, String);

      let createdAtDate = createdAt;
      if (!(createdAtDate instanceof Date) && createdAtDate && typeof createdAtDate === 'object' && '$date' in createdAtDate) {
        createdAtDate = new Date(createdAtDate.$date);
      }
      if (!(createdAtDate instanceof Date) || Number.isNaN(createdAtDate.getTime())) {
        throw new Meteor.Error('invalid-createdAt', 'createdAt must be a valid Date supplied by the client');
      }

      const doc = {
        _id: Random.id(),
        createdAt: new Date(createdAtDate.getTime()),
        sessionId,
      };

      await LinksCollection.insertAsync(doc);
      return doc._id;
    },
    async "links.clear"() {
      await LinksCollection.removeAsync({});
    },
    async "links.clearSession"(sessionId) {
      check(sessionId, String);
      await LinksCollection.removeAsync({ sessionId });
    }
  });
});
