import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import '../imports/api/runs.js';
import '../imports/api/baselines.js';
import '../imports/api/jobs.js';
import './seed-admin.js';

// Rate limit all methods: max 20 calls per 10 seconds per connection
DDPRateLimiter.addRule({
  type: 'method',
  name: (name) => !name.startsWith('login') && !name.startsWith('logout'),
}, 20, 10000);

// Rate limit job creation: max 5 per minute per user
DDPRateLimiter.addRule({
  type: 'method',
  name: 'jobs.create',
  userId: () => true,
}, 5, 60000);
