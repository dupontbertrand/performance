import { Template } from 'meteor/templating';
import { Meteor } from 'meteor/meteor';
import { FlowRouter } from 'meteor/ostrio:flow-router-extra';
import './main.html';

Template.mainLayout.helpers({
  activeIf(routeName) {
    return FlowRouter.getRouteName() === routeName ? 'active' : '';
  },
});

Template.mainLayout.events({
  'click .js-logout'(event) {
    event.preventDefault();
    Meteor.logout(() => FlowRouter.go('/'));
  },
});
