import './otel.js'; // TODO: os dados da v8 só sao enviados pro prometheus quando fazemos assim
import { beginLinksRoundtrip } from './otel.js';
import { Meteor } from 'meteor/meteor';
import { LinksCollection } from '/imports/api/links';
import { Random } from 'meteor/random';
import { check } from 'meteor/check';

Meteor.startup(async () => {

  console.log('Server started');
  console.log(`MongoDB URL: ${process.env.MONGO_URL}`);
  console.log(`MongoDB Oplog URL: ${process.env.MONGO_OPLOG_URL}`);


  // // implement a leak of memory of 100MB each second for testing purposes
  let leak = [];
  setInterval(() => {
    // for(let i = 0; i < 10; i++) {
      leak.push(new Array(5 * 1024 * 1024).fill(0));
    // } 

    const bytesToGB = b => b / (1024 ** 3);

    
    // apresente o total de memoria usada pelo processo
    const memoryUsage = process.memoryUsage();
    console.log(`Memory usage: RSS ${bytesToGB(memoryUsage.rss).toFixed(2)} GB, Heap Used ${bytesToGB(memoryUsage.heapUsed).toFixed(2)} GB`);
  }, 1000);
  

  Meteor.publish("links", function () {
    return LinksCollection.find({ scriptRunId: { $exists: false } });
  });

  Meteor.methods({
    async "links.insert"(traceContext = {}) {
      const { sessionId, createdAt } = traceContext;
      check(sessionId, String);

      const roundtrip = beginLinksRoundtrip(sessionId);

      let createdAtDate = createdAt;
      if (!(createdAtDate instanceof Date) && createdAtDate && typeof createdAtDate === 'object' && '$date' in createdAtDate) {
        createdAtDate = new Date(createdAtDate.$date);
      }
      if (!(createdAtDate instanceof Date) || Number.isNaN(createdAtDate.getTime())) {
        const err = new Meteor.Error('invalid-createdAt', 'createdAt must be a valid Date supplied by the client');
        roundtrip.fail(err);
        throw err;
      }

      const doc = {
        _id: Random.id(),
        createdAt: new Date(createdAtDate.getTime()),
        sessionId,
      };

      roundtrip.setDocId(doc._id);

      try {
        await roundtrip.run(() => LinksCollection.insertAsync(doc));
        return doc._id;
      } catch (error) {
        roundtrip.fail(error);
        throw error;
      }
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
