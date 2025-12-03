import { Meteor } from 'meteor/meteor';
import { LinksCollection } from '/imports/api/links';
import '../meteor-opentelemetry/opentelemetry-server';
import { context, propagation, SpanStatusCode } from '@opentelemetry/api';
import { Random } from 'meteor/random';
import { check } from 'meteor/check';
import {
  extractInsertionContext,
  startObserverSpan,
  startServerInsertSpan,
} from '/imports/clients/links-otel';

Meteor.startup(async () => {

  console.log('Server started');
  console.log(`MongoDB URL: ${process.env.MONGO_URL}`);
  console.log(`MongoDB Oplog URL: ${process.env.MONGO_OPLOG_URL}`);

  Meteor.publish("links", function () {
    return LinksCollection.find({ scriptRunId: { $exists: false } });
  });

  Meteor.methods({
    async "links.insert"(traceContext = {}) {
      const { carrier, sessionId, createdAt } = traceContext;
      check(sessionId, String);
      
      const { insertionContext } = extractInsertionContext({ carrier });
      const { span, spanContext: methodContext } = startServerInsertSpan(insertionContext);

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

      try {
        // Persist minimal parent carrier for observer correlation
        const parentCarrier = {};
        propagation.inject(methodContext, parentCarrier, {
          set: (target, key, value) => {
            target[key] = value;
          },
        });
        if (parentCarrier.traceparent) {
          doc._otel = { parent: { traceparent: parentCarrier.traceparent } };
        }

        await context.with(methodContext, () => LinksCollection.insertAsync(doc));
        span.setStatus({ code: SpanStatusCode.OK });
        return doc._id;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error?.message,
        });
        throw error;
      } finally {
        span.end();
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


  LinksCollection.find({ 'trace.observerSpanId': { $exists: false }, 'scriptRunId': { $exists: false } }, { fields: { _otel: 1 } }).observe({
    added(doc) {
      const span = startObserverSpan(doc);
      if (!span) return;

      LinksCollection.updateAsync(doc._id, { $set: { 'trace.observerSpanId': span.spanContext().spanId } });
      span.end();
    }
  });
});
