const linksPublicationProjection = {};

const noopSpanMethods = {
  setAttribute() {},
  setStatus() {},
  recordException() {},
  end() {},
};

const createNoopSpan = () => ({ ...noopSpanMethods });

export function startUiInsertSpan() {
  return {
    span: createNoopSpan(),
    context: undefined,
    carrier: {},
  };
}

export function extractInsertionContext() {
  return { insertionContext: undefined };
}

export function startObserverSpan() {
  return null;
}

export function startServerInsertSpan() {
  return {
    span: createNoopSpan(),
    spanContext: undefined,
  };
}

export { linksPublicationProjection };
