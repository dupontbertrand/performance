import { Template } from 'meteor/templating';
import { Meteor } from 'meteor/meteor';
import { ReactiveVar } from 'meteor/reactive-var';
import { Jobs } from '../../api/jobs';
import './admin.html';

Template.admin.onCreated(function () {
  this.subscribe('jobs.all');
  this.selectedBranch = new ReactiveVar('devel');
  this.branches = new ReactiveVar(['devel', 'release-3.5', 'release-3.4']);
  this.selectedScenarios = new ReactiveVar(
    [...(Meteor.settings?.public?.scenarios || [])],
  );
  this.error = new ReactiveVar('');
  this.success = new ReactiveVar('');
  this.launching = new ReactiveVar(false);
  this.agentStatus = new ReactiveVar(null);

  // Fetch branches from server
  Meteor.call('jobs.getBranches', (err, result) => {
    if (!err && result?.length) {
      this.branches.set(result);
    }
  });

  // Poll agent status every 15s
  const pollAgent = () => {
    Meteor.call('jobs.getAgentStatus', (err, result) => {
      if (!err) this.agentStatus.set(result);
    });
  };
  pollAgent();
  this.agentInterval = setInterval(pollAgent, 15000);
});

Template.admin.onDestroyed(function () {
  if (this.agentInterval) clearInterval(this.agentInterval);
});

Template.admin.onRendered(function () {
  this.$('.js-scenario-check').prop('checked', true);
});

Template.admin.helpers({
  selectedBranch() {
    return Template.instance().selectedBranch.get();
  },
  branches() {
    return Template.instance().branches.get();
  },
  scenarios() {
    return Meteor.settings?.public?.scenarios || [];
  },
  error() {
    return Template.instance().error.get();
  },
  success() {
    return Template.instance().success.get();
  },
  launching() {
    return Template.instance().launching.get();
  },
  jobs() {
    return Jobs.find({ _id: { $nin: ['__branches__', '__agent__'] } }, { sort: { createdAt: -1 } });
  },
  hasJobs() {
    return Jobs.find({ _id: { $nin: ['__branches__', '__agent__'] } }).count() > 0;
  },
  joinScenarios(scenarios) {
    if (!scenarios) return '-';
    return scenarios.join(', ');
  },
  statusBadge(status) {
    const badges = {
      pending: '<span class="badge bg-secondary">Pending</span>',
      running: '<span class="badge bg-info">Running</span>',
      done: '<span class="badge bg-success">Done</span>',
      failed: '<span class="badge bg-danger">Failed</span>',
    };
    return badges[status] || `<span class="badge bg-secondary">${status}</span>`;
  },
  progressCell(job) {
    if (job.status === 'pending') return '-';
    if (job.status === 'done') return `${job.scenarios.length}/${job.scenarios.length}`;
    if (job.status === 'failed') {
      const current = job.progress?.current || 0;
      return `${current}/${job.scenarios.length} (failed)`;
    }
    // running
    const p = job.progress;
    if (!p) return '...';
    const scenario = p.currentScenario || '...';
    return `${p.current}/${p.total} <span class="text-info">${scenario}</span>`;
  },
  runLinks(runIds) {
    if (!runIds?.length) return '';
    return runIds.map((id) => `<a href="/run/${id}" class="badge bg-outline-secondary text-decoration-none me-1">${id.slice(0, 6)}</a>`).join('');
  },
  agentStatusHtml() {
    const agent = Template.instance().agentStatus.get();
    if (!agent?.lastSeen) {
      return '<span class="text-muted">No agent connected</span>';
    }
    const ago = Math.round((Date.now() - new Date(agent.lastSeen).getTime()) / 1000);
    if (ago < 60) {
      return `<span class="badge bg-success">Online</span> <span class="text-muted">last seen ${ago}s ago</span>`;
    }
    if (ago < 300) {
      return `<span class="badge bg-warning text-dark">Idle</span> <span class="text-muted">last seen ${Math.round(ago / 60)}min ago</span>`;
    }
    return `<span class="badge bg-danger">Offline</span> <span class="text-muted">last seen ${Math.round(ago / 60)}min ago</span>`;
  },
  formatDate(date) {
    if (!date) return '-';
    return new Date(date).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  },
  isEq(a, b) {
    return a === b;
  },
  truncate(str, len) {
    if (!str) return '';
    return str.length > len ? `${str.slice(0, len)}...` : str;
  },
});

Template.admin.events({
  'change .js-branch'(event, instance) {
    instance.selectedBranch.set(event.target.value);
  },
  'change .js-scenario-check'(event, instance) {
    const scenario = event.target.value;
    const selected = instance.selectedScenarios.get();
    if (event.target.checked) {
      instance.selectedScenarios.set([...selected, scenario]);
    } else {
      instance.selectedScenarios.set(selected.filter((s) => s !== scenario));
    }
  },
  'click .js-select-all'(event, instance) {
    event.preventDefault();
    instance.selectedScenarios.set(
      [...(Meteor.settings?.public?.scenarios || [])],
    );
    instance.$('.js-scenario-check').prop('checked', true);
  },
  'click .js-deselect-all'(event, instance) {
    event.preventDefault();
    instance.selectedScenarios.set([]);
    instance.$('.js-scenario-check').prop('checked', false);
  },
  'click .js-launch'(event, instance) {
    event.preventDefault();
    const branch = instance.selectedBranch.get().trim();
    const scenarios = instance.selectedScenarios.get();

    instance.error.set('');
    instance.success.set('');

    if (!branch) {
      instance.error.set('Enter a branch name');
      return;
    }
    if (scenarios.length === 0) {
      instance.error.set('Select at least one scenario');
      return;
    }

    instance.launching.set(true);
    Meteor.call('jobs.create', branch, scenarios, (err) => {
      instance.launching.set(false);
      if (err) {
        instance.error.set(err.reason || err.message);
      } else {
        instance.success.set(`Job queued: ${branch} (${scenarios.length} scenarios)`);
        setTimeout(() => instance.success.set(''), 5000);
      }
    });
  },
  'click .js-cancel'(event) {
    event.preventDefault();
    const jobId = event.currentTarget.dataset.id;
    Meteor.call('jobs.cancel', jobId);
  },
});
