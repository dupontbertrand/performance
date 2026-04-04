import { Template } from 'meteor/templating';
import './about.html';

// Static page — no subscriptions or helpers needed
Template.about.onCreated(function () {});
