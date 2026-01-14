/**
 * Tracing Utilities for Meteor
 *
 * Provides convenient helpers for creating spans and tracing async operations.
 */

import { trace, SpanStatusCode, context } from '@opentelemetry/api';

/**
 * Create a simple span and execute a function within it.
 *
 * @param {string} tracerName - Tracer name
 * @param {string} spanName - Span name
 * @param {Function} fn - Function to execute
 * @param {Object} attributes - Optional span attributes
 * @returns {Promise<*>} Result of the function
 *
 * @example
 * const result = await withSpan('my-service', 'processOrder', async () => {
 *   return await processOrder(orderId);
 * }, { 'order.id': orderId });
 */
export async function withSpan(tracerName, spanName, fn, attributes = {}) {
  const tracer = trace.getTracer(tracerName);
  const span = tracer.startSpan(spanName, { attributes });
  const spanContext = trace.setSpan(context.active(), span);

  try {
    const result = await context.with(spanContext, fn);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error?.message || 'Operation failed',
    });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Create a synchronous span and execute a function within it.
 *
 * @param {string} tracerName - Tracer name
 * @param {string} spanName - Span name
 * @param {Function} fn - Function to execute
 * @param {Object} attributes - Optional span attributes
 * @returns {*} Result of the function
 */
export function withSpanSync(tracerName, spanName, fn, attributes = {}) {
  const tracer = trace.getTracer(tracerName);
  const span = tracer.startSpan(spanName, { attributes });
  const spanContext = trace.setSpan(context.active(), span);

  try {
    const result = context.with(spanContext, fn);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error?.message || 'Operation failed',
    });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Create a span builder for more complex tracing scenarios.
 *
 * @param {string} tracerName - Tracer name
 * @returns {Object} Span builder
 *
 * @example
 * const builder = createSpanBuilder('my-service');
 * const span = builder.start('myOperation', { 'user.id': userId });
 * try {
 *   // do work
 *   span.addEvent('checkpoint', { step: 1 });
 *   // more work
 *   span.success();
 * } catch (error) {
 *   span.error(error);
 *   throw error;
 * }
 */
export function createSpanBuilder(tracerName) {
  const tracer = trace.getTracer(tracerName);

  return {
    /**
     * Start a new span.
     *
     * @param {string} spanName - Span name
     * @param {Object} attributes - Optional span attributes
     * @returns {Object} Span handle
     */
    start(spanName, attributes = {}) {
      const span = tracer.startSpan(spanName, { attributes });
      const spanContext = trace.setSpan(context.active(), span);

      return {
        /**
         * Add an event to the span.
         */
        addEvent(name, attrs = {}) {
          span.addEvent(name, attrs);
          return this;
        },

        /**
         * Set an attribute on the span.
         */
        setAttribute(key, value) {
          span.setAttribute(key, value);
          return this;
        },

        /**
         * Set multiple attributes on the span.
         */
        setAttributes(attrs) {
          Object.entries(attrs).forEach(([key, value]) => {
            span.setAttribute(key, value);
          });
          return this;
        },

        /**
         * Mark the span as successful and end it.
         */
        success() {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        },

        /**
         * Mark the span as failed and end it.
         */
        error(err) {
          if (err) {
            span.recordException(err);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err?.message || 'Operation failed',
            });
          } else {
            span.setStatus({ code: SpanStatusCode.ERROR });
          }
          span.end();
        },

        /**
         * Run a function within this span's context.
         */
        run(fn) {
          return context.with(spanContext, fn);
        },

        /**
         * Run an async function within this span's context.
         */
        async runAsync(fn) {
          return context.with(spanContext, fn);
        },

        /**
         * Get the underlying OpenTelemetry span.
         */
        getSpan() {
          return span;
        },

        /**
         * Get the span context for propagation.
         */
        getContext() {
          return spanContext;
        },
      };
    },
  };
}

/**
 * Extract trace context from incoming request headers for distributed tracing.
 *
 * @param {Object} headers - Request headers
 * @returns {Object} Context for propagation
 */
export function extractTraceContext(headers) {
  // This is a placeholder - full implementation would use W3C trace context propagation
  // The OpenTelemetry SDK handles this automatically for HTTP requests
  return context.active();
}

/**
 * Inject trace context into outgoing request headers for distributed tracing.
 *
 * @param {Object} headers - Headers object to inject into
 * @returns {Object} Headers with trace context
 */
export function injectTraceContext(headers = {}) {
  // This is a placeholder - full implementation would use W3C trace context propagation
  // The OpenTelemetry SDK handles this automatically for HTTP requests
  return headers;
}
