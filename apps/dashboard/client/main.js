import { FlowRouter } from 'meteor/ostrio:flow-router-extra';

// Layouts
import '../imports/ui/layouts/main.js';

// Pages
import '../imports/ui/pages/dashboard.js';
import '../imports/ui/pages/compare.js';
import '../imports/ui/pages/trends.js';
import '../imports/ui/pages/detail.js';

// Routes
FlowRouter.route('/', {
  name: 'dashboard',
  action() {
    this.render('mainLayout', { content: 'dashboard' });
  },
});

FlowRouter.route('/compare', {
  name: 'compare',
  action() {
    this.render('mainLayout', { content: 'compare' });
  },
});

FlowRouter.route('/trends', {
  name: 'trends',
  action() {
    this.render('mainLayout', { content: 'trends' });
  },
});

FlowRouter.route('/run/:id', {
  name: 'detail',
  action() {
    this.render('mainLayout', { content: 'detail' });
  },
});
