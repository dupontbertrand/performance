const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const DEFAULT_HTTP_ENDPOINT = process.env.REMOTE_URL || 'http://localhost:3000';
const DEFAULT_DDP_ENDPOINT = process.env.DDP_URL || toWebsocket(DEFAULT_HTTP_ENDPOINT);
const CONNECT_TIMEOUT_MS = parseInt(process.env.DDP_CONNECT_TIMEOUT_MS || '15000', 10);
const METHOD_TIMEOUT_MS = parseInt(process.env.DDP_METHOD_TIMEOUT_MS || '60000', 10);
const SUB_TIMEOUT_MS = parseInt(process.env.DDP_SUB_TIMEOUT_MS || '15000', 10);

function toWebsocket(httpUrl) {
  const trimmed = httpUrl.endsWith('/') ? httpUrl.slice(0, -1) : httpUrl;
  if (trimmed.startsWith('ws')) {
    return trimmed.endsWith('/websocket') ? trimmed : `${trimmed}/websocket`;
  }
  const converted = trimmed.replace(/^http/i, 'ws');
  return `${converted}/websocket`;
}

class DdpClient {
  constructor({ endpoint = DEFAULT_DDP_ENDPOINT, connectTimeout = CONNECT_TIMEOUT_MS, methodTimeout = METHOD_TIMEOUT_MS, subTimeout = SUB_TIMEOUT_MS } = {}) {
    this.endpoint = endpoint;
    this.connectTimeout = connectTimeout;
    this.methodTimeout = methodTimeout;
    this.subTimeout = subTimeout;
    this.ws = null;
    this.session = null;
    this.methodId = 0;
    this.subId = 0;
    this.pendingMethods = new Map();
    this.pendingSubs = new Map();
    this.connectingPromise = null;
    this._boundHandleMessage = this._handleMessage.bind(this);
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.session;
    }
    if (this.connectingPromise) {
      return this.connectingPromise;
    }
    this.connectingPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint, { handshakeTimeout: this.connectTimeout });
      let settled = false;

      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
      };

      const onOpen = () => {
        ws.send(JSON.stringify({
          msg: 'connect',
          version: '1',
          support: ['1', 'pre2', 'pre1'],
        }));
      };

      const onMessage = (data) => {
        try {
          const payload = JSON.parse(data.toString());
          if (payload.msg === 'connected') {
            this.session = payload.session;
            ws.off('message', onMessage);
            ws.on('message', this._boundHandleMessage);
            settled = true;
            cleanup();
            resolve(this.session);
            return;
          }
          if (payload.msg === 'failed') {
            settled = true;
            cleanup();
            reject(new Error(`DDP connection failed: ${payload.reason || payload.version || 'unknown reason'}`));
            return;
          }
          this._dispatch(payload);
        } catch (err) {
          // Ignore malformed payloads but ensure connection eventually closes
          console.warn('DDP message parse error', err);
        }
      };

      const onError = (err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      };

      const onClose = () => {
        ws.off('message', this._boundHandleMessage);
        this._rejectAllPending(new Error('DDP connection closed'));
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('DDP connection closed before handshake'));
        }
      };

      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);

      this.ws = ws;
    });

    try {
      await this.connectingPromise;
      return this.session;
    } finally {
      this.connectingPromise = null;
    }
  }

  async disconnect() {
    if (this.ws) {
      this.ws.off('message', this._boundHandleMessage);
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    }
    this._rejectAllPending(new Error('DDP client disconnected'));
    this.ws = null;
    this.session = null;
  }

  _handleMessage(data) {
    try {
      const payload = JSON.parse(data.toString());
      this._dispatch(payload);
    } catch (err) {
      console.warn('DDP message parse error', err);
    }
  }

  async call(method, params = {}) {
    await this.connect();
    const id = (this.methodId += 1).toString();

    const payload = {
      msg: 'method',
      method,
      params: [params],
      id,
    };

    const pendingPromise = new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingMethods.delete(id);
        reject(new Error(`Method ${method} timed out after ${this.methodTimeout}ms`));
      }, this.methodTimeout);

      this.pendingMethods.set(id, { resolve, reject, timeoutHandle });
    });

    this.ws.send(JSON.stringify(payload));
    return pendingPromise;
  }

  async subscribe(name, params = []) {
    await this.connect();
    const id = (this.subId += 1).toString();

    const payload = {
      msg: 'sub',
      id,
      name,
      params,
    };

    const pendingPromise = new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingSubs.delete(id);
        reject(new Error(`Subscription ${name} timed out after ${this.subTimeout}ms`));
      }, this.subTimeout);

      this.pendingSubs.set(id, { resolve, reject, timeoutHandle });
    });

    this.ws.send(JSON.stringify(payload));
    return pendingPromise;
  }

  async unsubscribe(id) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({ msg: 'unsub', id }));
  }

  _dispatch(message) {
    switch (message.msg) {
      case 'result': {
        const pending = this.pendingMethods.get(message.id);
        if (pending) {
          clearTimeout(pending.timeoutHandle);
          this.pendingMethods.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.reason || message.error.message || 'DDP method error'));
          } else {
            pending.resolve(message.result);
          }
        }
        break;
      }
      case 'updated': {
        // No-op: method updated notifications are not required for this client
        break;
      }
      case 'ready': {
        if (!Array.isArray(message.subs)) {
          break;
        }
        message.subs.forEach((subId) => {
          const pending = this.pendingSubs.get(subId);
          if (pending) {
            clearTimeout(pending.timeoutHandle);
            this.pendingSubs.delete(subId);
            pending.resolve(subId);
          }
        });
        break;
      }
      case 'nosub': {
        const pending = this.pendingSubs.get(message.id);
        if (pending) {
          clearTimeout(pending.timeoutHandle);
          this.pendingSubs.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.reason || message.error.message || 'DDP nosub error'));
          } else {
            pending.reject(new Error('Subscription cancelled by server'));
          }
        }
        break;
      }
      case 'ping': {
        const payload = { msg: 'pong' };
        if (message.id) {
          payload.id = message.id;
        }
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(payload));
        }
        break;
      }
      default: {
        // DDP will stream document diffs as added/changed/removed messages. For this stress
        // client we do not hydrate a minimongo cache, so consuming the payloads would be work
        // with no benefit. Discarding them keeps the client lightweight while still forcing
        // the server to produce the same workload it would for a real UI.
        break;
      }
    }
  }

  _rejectAllPending(err) {
    this.pendingMethods.forEach(({ reject, timeoutHandle }) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
    this.pendingMethods.clear();

    this.pendingSubs.forEach(({ reject, timeoutHandle }) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
    this.pendingSubs.clear();
  }
}

async function addAndRemoveTasks({ client, reactive = true, taskCount, manageSubscription = true }) {
  const count = Number.isFinite(taskCount) ? taskCount : parseInt(process.env.TASK_COUNT || '20', 10);
  const sessionId = randomUUID();
  const createdTaskIds = [];
  const managedSubscriptionIds = [];

  if (reactive && manageSubscription) {
    try {
      const subscriptionId = await client.subscribe('fetchTasks');
      if (subscriptionId) {
        managedSubscriptionIds.push(subscriptionId);
      }
    } catch (err) {
      console.warn('Failed to subscribe to fetchTasks publication', err);
    }
  }

  await client.call('removeAllTasks', { sessionId });

  for (let index = 1; index <= count; index += 1) {
    const description = `New Task ${index}`;
    const taskId = await client.call('insertTask', { sessionId, description });
    if (taskId) {
      createdTaskIds.push(taskId);
    }
    if (!reactive) {
      await client.call('fetchTasks');
    }
  }

  while (createdTaskIds.length) {
    const nextTaskId = createdTaskIds.shift();
    await client.call('removeTask', { taskId: nextTaskId });
    if (!reactive) {
      await client.call('fetchTasks');
    }
  }

  await client.call('removeAllTasks', { sessionId });

  if (reactive && manageSubscription && managedSubscriptionIds.length) {
    await Promise.all(managedSubscriptionIds.map(async (id) => {
      try {
        await client.unsubscribe(id);
      } catch (err) {
        console.warn(`Failed to unsubscribe fetchTasks (${id})`, err);
      }
    }));
  }
}

async function beforeScenario(context) {
  context.vars = context.vars || {};
  const existingClient = context?.vars?.ddpClient;
  if (existingClient) {
    try {
      await existingClient.connect();
      return;
    } catch (err) {
      console.warn('Existing DDP client unusable, creating a new one', err);
    }
  }

  const client = new DdpClient({ endpoint: DEFAULT_DDP_ENDPOINT });
  await client.connect();
  context.vars.ddpClient = client;
}

async function afterScenario(context) {
  if (!context?.vars) {
    return;
  }
  const { ddpClient } = context.vars;
  if (ddpClient) {
    await ddpClient.disconnect();
    context.vars.ddpClient = null;
  }
}

async function reactivePubSubTasksDdp(context) {
  const { ddpClient } = context.vars;
  const subsPerClient = Math.max(1, parseInt(process.env.SUBSCRIPTIONS_PER_CLIENT || '5', 10));
  const reactiveRounds = Math.max(1, parseInt(process.env.o || '1', 10));
  const includeNonReactive = (process.env.INCLUDE_NON_REACTIVE || 'false').toLowerCase() !== 'false';
  const nonReactiveRounds = Math.max(1, parseInt(process.env.NON_REACTIVE_ROUNDS || '1', 10));
  const managedSubscriptions = [];

  for (let index = 0; index < subsPerClient; index += 1) {
    try {
      const subId = await ddpClient.subscribe('fetchTasks');
      if (subId) {
        managedSubscriptions.push(subId);
      }
    } catch (err) {
      console.warn(`Failed to establish subscription ${index + 1}/${subsPerClient}`, err);
    }
  }

  try {
    for (let round = 0; round < reactiveRounds; round += 1) {
      await addAndRemoveTasks({ client: ddpClient, reactive: true, manageSubscription: false });
    }

    if (includeNonReactive) {
      for (let round = 0; round < nonReactiveRounds; round += 1) {
        await addAndRemoveTasks({ client: ddpClient, reactive: false });
      }
    }
  } finally {
    if (managedSubscriptions.length) {
      await Promise.all(managedSubscriptions.map(async (subId) => {
        try {
          await ddpClient.unsubscribe(subId);
        } catch (err) {
          console.warn(`Failed to clean up subscription ${subId}`, err);
        }
      }));
    }
  }
}

module.exports = {
  beforeScenario,
  afterScenario,
  reactivePubSubTasksDdp,
  addAndRemoveTasks,
  DdpClient,
};