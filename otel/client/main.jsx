import React from 'react';
import { createRoot } from 'react-dom/client';
import { Meteor } from 'meteor/meteor';
import { App } from '/imports/ui/App';

// Set up an OpenTelemetry provider using the local instrumentation source
// (required to have client-to-server DDP tracing)
import '../meteor-opentelemetry/opentelemetry-client';

Meteor.startup(() => {
  const container = document.getElementById('react-target');
  const root = createRoot(container);
  root.render(<App />);
});
