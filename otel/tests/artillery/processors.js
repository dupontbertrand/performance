const crypto = require('crypto');

const CONNECT_MESSAGE = {
  msg: 'connect',
  version: '1',
  support: ['1', 'pre2', 'pre1'],
};

const DEFAULT_TIMEOUT_MS = 15_000;

function randomSessionId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(12).toString('hex');
}

function decodeMeteorDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, '$date')) {
      const parsed = new Date(value.$date);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  return null;
}

function waitForResponse(context, events, matcher, onSuccess, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let completed = false;

    const timer = setTimeout(() => {
      if (completed) {
        return;
      }
      completed = true;
      context.ws.removeListener('message', handler);
      const error = new Error('Timeout DDP response.');
      events.emit('error', error);
      reject(error);
    }, timeoutMs);

    function finish(fn, value) {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timer);
      context.ws.removeListener('message', handler);
      fn(value);
    }

    function handler(raw) {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }

      if (payload.msg === 'ping') {
        const pong = payload.id ? { msg: 'pong', id: payload.id } : { msg: 'pong' };
        context.ws.send(JSON.stringify(pong));
        return;
      }

      if (!matcher(payload)) {
        return;
      }

      try {
        const result = onSuccess ? onSuccess(payload) : undefined;
        if (result && typeof result.then === 'function') {
          result.then((value) => finish(resolve, value)).catch((err) => {
            events.emit('error', err);
            finish(reject, err);
          });
        } else {
          finish(resolve, result);
        }
      } catch (err) {
        events.emit('error', err);
        finish(reject, err);
      }
    }

    context.ws.on('message', handler);
  });
}

function ensureDdpMessageHandler(context, events) {
  if (context.vars.ddpHandlerInstalled) {
    return;
  }

  context.vars.pendingSessionInserts = [];
  context.vars.roundTripTimeoutMs = context.vars.roundTripTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  context.ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    if (payload.msg === 'ping') {
      const pong = payload.id ? { msg: 'pong', id: payload.id } : { msg: 'pong' };
      context.ws.send(JSON.stringify(pong));
      return;
    }

    if (payload.msg !== 'added' || payload.collection !== 'links') {
      return;
    }

    const docSession = payload.fields?.sessionId;
    if (!docSession || docSession !== context.vars.sessionId) {
      return;
    }

    const queue = context.vars.pendingSessionInserts ?? [];
    if (queue.length === 0) {
      return;
    }

    const docId = payload.id;
    let entryIndex = -1;

    if (docId) {
      entryIndex = queue.findIndex((item) => item && !item.cancelled && item.docId === docId);
    }

    if (entryIndex === -1) {
      entryIndex = queue.findIndex((item) => item && !item.cancelled);
    }

    if (entryIndex === -1) {
      return;
    }

    const [entry] = queue.splice(entryIndex, 1);
    if (!entry) {
      return;
    }

    const createdAtDate = decodeMeteorDate(payload.fields?.createdAt);
    if (!createdAtDate) {
      events.emit('counter', 'links_missing_createdAt', 1);
      entry.resolve();
      return;
    }

    const duration = Date.now() - createdAtDate.getTime();

    if (duration >= 0) {
      events.emit('histogram', 'links_roundtrip_createdAt_ms', duration);
    } else {
      events.emit('counter', 'links_negative_createdAt_latency', 1);
    }

    entry.resolve();
  });

  context.vars.ddpHandlerInstalled = true;
}

function initSession(context, events, done) {
  context.vars.sessionId = randomSessionId();
  context.vars.methodSeq = 0;
  context.vars.subSeq = 0;
  ensureDdpMessageHandler(context, events);
  done();
}

function connectToDdp(context, events, done) {
  waitForResponse(
    context,
    events,
    (payload) => payload.msg === 'connected' || payload.msg === 'failed',
    (payload) => {
      if (payload.msg === 'failed') {
        throw new Error(`Não foi possível conectar ao DDP: ${payload.reason ?? 'motivo desconhecido'}`);
      }
    },
    10_000,
  )
    .then(() => done())
    .catch((err) => done(err));

  context.ws.send(JSON.stringify(CONNECT_MESSAGE));
}

function nextMethodId(context, prefix) {
  context.vars.methodSeq += 1;
  return `${prefix}-${context.vars.methodSeq}`;
}

function callMethod(context, events, method, params, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const id = nextMethodId(context, method);

  const waitPromise = waitForResponse(
    context,
    events,
    (payload) => payload.msg === 'result' && payload.id === id,
    (payload) => {
      if (payload.error) {
        const { message = 'Erro desconhecido ao chamar método Meteor', details } = payload.error;
        const error = new Error(message);
        if (details) {
          error.details = details;
        }
        throw error;
      }
      return payload.result;
    },
    timeoutMs,
  );

  context.ws.send(
    JSON.stringify({
      msg: 'method',
      id,
      method,
      params,
    }),
  );

  return waitPromise;
}

function nextSubscriptionId(context) {
  context.vars.subSeq += 1;
  return `sub-${context.vars.subSeq}`;
}

function subscribeLinks(context, events, done) {
  const subId = nextSubscriptionId(context);
  context.vars.linksSubId = subId;

  waitForResponse(
    context,
    events,
    (payload) =>
      (payload.msg === 'ready' && Array.isArray(payload.subs) && payload.subs.includes(subId)) ||
      (payload.msg === 'nosub' && payload.id === subId),
    (payload) => {
      if (payload.msg === 'nosub') {
        const reason = payload.error?.reason ?? 'motivo desconhecido';
        throw new Error(`Falha ao assinar publicação links: ${reason}`);
      }
    },
  )
    .then(() => done())
    .catch((err) => done(err));

  context.ws.send(
    JSON.stringify({
      msg: 'sub',
      id: subId,
      name: 'links',
      params: [],
    }),
  );
}

function insertTask(context, events, done) {
  const queue = context.vars.pendingSessionInserts ?? [];

  let entry;
  const observePromise = new Promise((resolve, reject) => {
    const timeoutMs = context.vars.roundTripTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (entry) {
        entry.cancelled = true;
        const idx = queue.indexOf(entry);
        if (idx !== -1) {
          queue.splice(idx, 1);
        }
      }
      const error = new Error('Timeout waiting for document replication to client.');
      events.emit('error', error);
      reject(error);
    }, timeoutMs);

    entry = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
      cancelled: false,
      docId: null,
    };

    queue.push(entry);
  });

  const createdAt = new Date();

  const methodPromise = callMethod(
    context,
    events,
    'links.insert',
    [
      {
        carrier: {},
        sessionId: context.vars.sessionId,
        createdAt: {
          $date: createdAt.getTime(),
        },
      },
    ],
  )
    .then((docId) => {
      if (entry) {
        entry.docId = docId;
      }
      return docId;
    })
    .catch((err) => {
      if (entry) {
        entry.cancelled = true;
        const idx = queue.indexOf(entry);
        if (idx !== -1) {
          queue.splice(idx, 1);
        }
        entry.reject(err);
      }
      throw err;
    });

  Promise.all([methodPromise, observePromise])
    .then(() => done())
    .catch((err) => done(err));
}

function clearSession(context, events, done) {
  callMethod(context, events, 'links.clearSession', [context.vars.sessionId])
    .then(() => done())
    .catch((err) => done(err));
}

module.exports = {
  initSession,
  connectToDdp,
  subscribeLinks,
  insertTask,
  clearSession,
};
