import { Mongo } from 'meteor/mongo';
import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';

const Jobs = new Mongo.Collection('jobs');

const BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
const JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

Jobs.deny({
  insert() { return true; },
  update() { return true; },
  remove() { return true; },
});

function validateApiKey(apiKey) {
  const expected = Meteor.settings?.benchApiKey;
  if (!expected || apiKey !== expected) {
    throw new Meteor.Error('unauthorized', 'Invalid API key');
  }
}

function getValidScenarios() {
  return Meteor.settings?.public?.scenarios || [];
}

if (Meteor.isServer) {
  Jobs.createIndexAsync({ status: 1, createdAt: 1 });

  Meteor.publish('jobs.all', function () {
    if (!this.userId) return this.ready();
    return Jobs.find(
      { _id: { $nin: ['__branches__'] } },
      { sort: { createdAt: -1 }, limit: 100 },
    );
  });

  Meteor.methods({
    async 'jobs.create'(branch, scenarios) {
      if (!this.userId) {
        throw new Meteor.Error('unauthorized', 'Must be logged in');
      }
      check(branch, String);
      check(scenarios, [String]);

      if (!BRANCH_RE.test(branch)) {
        throw new Meteor.Error('invalid-branch', 'Invalid branch name');
      }
      if (scenarios.length === 0) {
        throw new Meteor.Error('invalid-scenarios', 'Select at least one scenario');
      }
      const valid = getValidScenarios();
      for (const s of scenarios) {
        if (!valid.includes(s)) {
          throw new Meteor.Error('invalid-scenario', `Unknown scenario: ${s}`);
        }
      }

      return await Jobs.insertAsync({
        branch,
        scenarios,
        status: 'pending',
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
        error: null,
        runIds: [],
        progress: { current: 0, total: scenarios.length, currentScenario: null },
        createdBy: this.userId,
      });
    },

    async 'jobs.claimNext'(apiKey) {
      check(apiKey, String);
      validateApiKey(apiKey);

      // Reset stale running jobs (>2h)
      await Jobs.updateAsync(
        { status: 'running', startedAt: { $lt: new Date(Date.now() - JOB_TIMEOUT_MS) } },
        { $set: { status: 'failed', completedAt: new Date(), error: 'Timed out after 2 hours' } },
        { multi: true },
      );

      // Atomically claim the oldest pending job
      const raw = Jobs.rawCollection();
      const result = await raw.findOneAndUpdate(
        { status: 'pending' },
        { $set: { status: 'running', startedAt: new Date() } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      );
      return result || null;
    },

    async 'jobs.updateProgress'(apiKey, jobId, current, currentScenario) {
      check(apiKey, String);
      check(jobId, String);
      check(current, Number);
      check(currentScenario, String);
      validateApiKey(apiKey);

      await Jobs.updateAsync(jobId, {
        $set: {
          'progress.current': current,
          'progress.currentScenario': currentScenario,
        },
      });
    },

    async 'jobs.heartbeat'(apiKey) {
      check(apiKey, String);
      validateApiKey(apiKey);

      await Jobs.upsertAsync(
        { _id: '__agent__' },
        { $set: { _id: '__agent__', lastSeen: new Date(), status: 'online' } },
      );
    },

    async 'jobs.getAgentStatus'() {
      const doc = await Jobs.findOneAsync('__agent__');
      return doc || null;
    },

    async 'jobs.markDone'(apiKey, jobId, runIds) {
      check(apiKey, String);
      check(jobId, String);
      check(runIds, [String]);
      validateApiKey(apiKey);

      await Jobs.updateAsync(jobId, {
        $set: { status: 'done', completedAt: new Date(), runIds },
      });
    },

    async 'jobs.markFailed'(apiKey, jobId, errorMsg) {
      check(apiKey, String);
      check(jobId, String);
      check(errorMsg, String);
      validateApiKey(apiKey);

      await Jobs.updateAsync(jobId, {
        $set: { status: 'failed', completedAt: new Date(), error: errorMsg },
      });
    },

    async 'jobs.updateBranches'(apiKey, branches) {
      check(apiKey, String);
      check(branches, [String]);
      validateApiKey(apiKey);

      // Store branches in a simple config collection-like pattern
      // Use Jobs collection with a special _id
      await Jobs.upsertAsync(
        { _id: '__branches__' },
        { $set: { _id: '__branches__', branches, updatedAt: new Date() } },
      );
    },

    async 'jobs.getBranches'() {
      const doc = await Jobs.findOneAsync('__branches__');
      return doc?.branches || ['devel', 'release-3.5', 'release-3.4'];
    },

    async 'jobs.cancel'(jobId) {
      if (!this.userId) {
        throw new Meteor.Error('unauthorized', 'Must be logged in');
      }
      check(jobId, String);

      const job = await Jobs.findOneAsync(jobId);
      if (!job) throw new Meteor.Error('not-found', 'Job not found');
      if (job.status !== 'pending') {
        throw new Meteor.Error('invalid-status', 'Can only cancel pending jobs');
      }

      await Jobs.updateAsync(jobId, {
        $set: { status: 'failed', completedAt: new Date(), error: 'Cancelled by admin' },
      });
    },
  });
}

export { Jobs };
