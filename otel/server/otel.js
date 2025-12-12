import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { PeriodicExportingMetricReader, MeterProvider } from '@opentelemetry/sdk-metrics';
import { metrics } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { HostMetrics } from '@opentelemetry/host-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';

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

// Exponha o meter provider globalmente para que instrumentations de runtime usem o mesmo export.
metrics.setGlobalMeterProvider(meterProvider);

// Métricas de runtime do Node/V8/event loop.
registerInstrumentations({
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
