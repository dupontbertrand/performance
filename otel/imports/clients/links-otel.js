import { context, trace, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';

const uiTracer = trace.getTracer('ui.links');
const observerTracer = trace.getTracer('links.observer');
const serverMethodTracer = trace.getTracer('links.method');

const carrierSetter = {
  set(target, key, value) {
    target[key] = value;
  },
};

const carrierGetter = {
  get(target, key) {
    return target[key];
  },
  keys(target) {
    return Object.keys(target);
  },
};

// Removed Map-based bookkeeping for observer parent; we now persist parent carrier in the document itself.

export function startUiInsertSpan() {
  const span = uiTracer.startSpan('client.document.submit', { kind: SpanKind.CLIENT });
  const activeContext = trace.setSpan(context.active(), span);
  const carrier = {};
  propagation.inject(activeContext, carrier, carrierSetter);
  return { span, context: activeContext, carrier };
}

export function extractInsertionContext(traceContext) {
  let insertionContext = context.active();

  if (traceContext?.carrier) {
    insertionContext = propagation.extract(ROOT_CONTEXT, traceContext.carrier, carrierGetter);
  }

  return { insertionContext };
}

export function startObserverSpan(doc) {
  if (doc?._otel?.server?.documentAddedSpanId || doc._otel?.documentAddedSpanId) {
    return null;
  }

  const telemetry = doc?._otel;
  let parentCarrier = telemetry?.parent;

  // Fallback: accept direct traceparent if present
  if (!parentCarrier && telemetry?.traceparent) {
    parentCarrier = { traceparent: telemetry.traceparent };
  }

  const parentContext = parentCarrier
    ? propagation.extract(ROOT_CONTEXT, parentCarrier, carrierGetter)
    : undefined;

  const span = parentContext
    ? observerTracer.startSpan('server.document.added', undefined, parentContext)
    : observerTracer.startSpan('server.document.added');

  span.setStatus({ code: SpanStatusCode.OK });

  return span;
}

export const linksPublicationProjection = { _otel: 0 };

export function startServerInsertSpan(parentContext) {
  const baseContext = parentContext ?? context.active();
  const span = serverMethodTracer.startSpan('server.links.insert', undefined, baseContext);
  const spanContext = trace.setSpan(baseContext, span);
  return { span, spanContext };
}
