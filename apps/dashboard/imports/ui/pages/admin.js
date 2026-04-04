import { Template } from 'meteor/templating';
import { Meteor } from 'meteor/meteor';
import { ReactiveVar } from 'meteor/reactive-var';
import { Jobs } from '../../api/jobs';
import './admin.html';

Template.admin.onCreated(function () {
  this.subscribe('jobs.all');
  this.branch = new ReactiveVar('devel');
  this.selectedScenarios = new ReactiveVar(
    [...(Meteor.settings?.public?.scenarios || [])],
  );
  this.error = new ReactiveVar('');
  this.success = new ReactiveVar('');
  this.launching = new ReactiveVar(false);
});

Template.admin.helpers({
  branch() {
    return Template.instance().branch.get();
  },
  scenarios() {
    return Meteor.settings?.public?.scenarios || [];
  },
  isSelected(scenario) {
    return Template.instance().selectedScenarios.get().includes(scenario);
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
    return Jobs.find({}, { sort: { createdAt: -1 } });
  },
  hasJobs() {
    return Jobs.find().count() > 0;
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
  'input .js-branch'(event, instance) {
    instance.branch.set(event.target.value);
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
    const branch = instance.branch.get().trim();
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
