import { Mongo } from 'meteor/mongo';
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';

const Baselines = new Mongo.Collection('baselines');

if (Meteor.isServer) {
  Baselines.createIndexAsync({ scenario: 1 }, { unique: true });

  Meteor.publish('baselines.all', function () {
    return Baselines.find({});
  });

  Meteor.methods({
    async 'baselines.set'(apiKey, scenario, runId) {
      check(apiKey, String);
      check(scenario, String);
      check(runId, String);

      const expectedKey = Meteor.settings?.benchApiKey;
      if (!expectedKey || apiKey !== expectedKey) {
        throw new Meteor.Error('unauthorized', 'Invalid API key');
      }

      return await Baselines.upsertAsync(
        { scenario },
        { $set: { scenario, runId, updatedAt: new Date() } }
      );
    },
  });
}

export { Baselines };
