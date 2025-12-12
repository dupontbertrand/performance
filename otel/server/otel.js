import { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode, context } from '@opentelemetry/api';
import { PeriodicExportingMetricReader, MeterProvider } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { metrics } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { HostMetrics } from '@opentelemetry/host-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
/* global MeteorX */

// Enable verbose logging only when OTEL_DEBUG=1 to help troubleshoot connectivity issues.
if (process.env.OTEL_DEBUG === '1') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const serviceName = process.env.OTEL_SERVICE_NAME || 'meteor-host';
const exportIntervalMs = Number(process.env.OTEL_METRICS_EXPORT_INTERVAL_MS || 60000);

// Respect OTEL_EXPORTER_OTLP_METRICS_ENDPOINT first, then generic OTEL_EXPORTER_OTLP_ENDPOINT.
const collectorUrl =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
  (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/?$/, '')}/v1/metrics`
    : 'http://localhost:4318/v1/metrics');

const traceCollectorUrl =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  (process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/?$/, '')}/v1/traces`
    : 'http://localhost:4318/v1/traces');

const resource = resourceFromAttributes({
  [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
});

const metricExporter = new OTLPMetricExporter({ url: collectorUrl });

const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: exportIntervalMs,
});

const meterProvider = new MeterProvider({
  resource,
  readers: [metricReader],
});

// Basic trace setup to ship spans to the collector. This keeps the tracer
// available for custom instrumentation (DDP roundtrips, etc.).
const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({
      url: traceCollectorUrl,
    })),
  ],
});

// Register as the global tracer provider so trace.getTracer(...) works
// everywhere in the app.
tracerProvider.register();

// Exponha o meter provider globalmente para que instrumentations de runtime usem o mesmo export.
metrics.setGlobalMeterProvider(meterProvider);

// Métricas e traces automáticos (runtime + MongoDB driver).
registerInstrumentations({
  tracerProvider,
  meterProvider,
  instrumentations: [
    new RuntimeNodeInstrumentation({
      // Exemplo: medir event loop a cada 5s (padrão 5000 ms).
      // eventLoopUtilizationMeasurementInterval: 5000,
    }),
  ],
});

// HostMetrics only collects host-level CPU/memory/network/disk metrics. No request-level data.
const hostMetrics = new HostMetrics({
  meterProvider,
  name: 'meteor-host-metrics',
  // Use default collection interval (1s) to keep per-minute aggregation lightweight.
});

hostMetrics.start();

// --- Roundtrip tracing for Meteor DDP publishes (links collection) -----------

const pendingInsertSpans = new Map();
const roundtripTracer = trace.getTracer('links.roundtrip');
let sendHookInstalled = false;

function installSendHookOnce() {
  if (sendHookInstalled || typeof MeteorX === 'undefined') return;
  const origSend = MeteorX.Session.prototype.send;
  MeteorX.Session.prototype.send = function send(payload, ...rest) {
    if (payload?.msg === 'added' && payload.collection === 'links' && payload.id) {
      const span = pendingInsertSpans.get(payload.id);
      if (span) {
        span.addEvent('ddp.send.added', { 'ddp.session.id': this.id });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        pendingInsertSpans.delete(payload.id);
      }
    }
    return origSend.call(this, payload, ...rest);
  };
  sendHookInstalled = true;
}

installSendHookOnce();

export function beginLinksRoundtrip(sessionId) {
  installSendHookOnce();

  const span = roundtripTracer.startSpan('links.insert->publish', {
    attributes: { 'links.sessionId': sessionId },
  });

  const spanContext = trace.setSpan(context.active(), span);

  let trackedDocId;
  let timer;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  return {
    setDocId(docId) {
      if (!docId) return;
      trackedDocId = docId;
      span.setAttribute('links.docId', docId);
      pendingInsertSpans.set(docId, span);
      clearTimer();
      timer = setTimeout(() => {
        if (pendingInsertSpans.get(docId) === span) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'timeout waiting for added' });
          span.end();
          pendingInsertSpans.delete(docId);
        }
      }, 30_000);
    },
    fail(error) {
      clearTimer();
      if (trackedDocId) {
        pendingInsertSpans.delete(trackedDocId);
      }
      if (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
      } else {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    },
    run(fn) {
      return context.with(spanContext, fn);
    },
  };
}
