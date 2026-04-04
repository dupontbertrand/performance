import { Template } from 'meteor/templating';
import { Meteor } from 'meteor/meteor';
import { ReactiveVar } from 'meteor/reactive-var';
import { FlowRouter } from 'meteor/ostrio:flow-router-extra';
import './login.html';

Template.login.onCreated(function () {
  this.error = new ReactiveVar('');
});

Template.login.helpers({
  error() {
    return Template.instance().error.get();
  },
});

Template.login.events({
  'submit .js-login-form'(event, instance) {
    event.preventDefault();
    const username = event.target.username.value.trim();
    const password = event.target.password.value;
    instance.error.set('');

    Meteor.loginWithPassword(username, password, (err) => {
      if (err) {
        instance.error.set('Invalid username or password');
      } else {
        FlowRouter.go('/admin');
      }
    });
  },
});
