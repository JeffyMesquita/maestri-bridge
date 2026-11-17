import { afterEach, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../src/chat.ts';
import { ChatStream } from '../src/chat-stream.ts';
import type { ChatStreamState } from '../src/chat-stream.ts';
import { WireClient } from '../src/client.ts';
import { isWireError } from '../src/errors.ts';
import type { Credentials } from '../src/types.ts';
import { startWsTestServer } from './helpers/test-server.ts';
import type { TestServer } from './helpers/test-server.ts';

const streams: ChatStream[] = [];
const servers: TestServer[] = [];

function chatSnapshot(conversationId: string): ChatSnapshot {
  return {
    terminalId: 't1',
    conversationId,
    enabled: true,
    status: 'idle',
    entries: [],
    unreadCount: 0,
    canClear: false,
  };
}

function credentials(server: TestServer): Credentials {
  return {
    host: server.host,
    port: server.port,
    pin: server.pin,
    token: 'token-123',
    deviceId: 'device-1',
    deviceName: 'Test',
    role: 'owner',
  };
}

function createStream(
  server: TestServer,
  options: Partial<ConstructorParameters<typeof ChatStream>[0]> = {},
): ChatStream {
  const stream = new ChatStream({
    client: new WireClient(credentials(server)),
    terminalId: 't1',
    ...options,
  });
  streams.push(stream);
  return stream;
}

function waitForState(
  stream: ChatStream,
  predicate: (state: ChatStreamState) => boolean,
): Promise<void> {
  if (predicate(stream.state)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const off = stream.onState((state) => {
      if (predicate(state)) {
        off();
        resolve();
      }
    });
  });
}

function nextSnapshot(stream: ChatStream): Promise<ChatSnapshot> {
  return new Promise<ChatSnapshot>((resolve) => {
    const off = stream.onSnapshot((snapshot) => {
      off();
      resolve(snapshot);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

afterEach(async () => {
  for (const stream of streams) {
    stream.stop();
  }
  streams.length = 0;
  for (const server of servers) {
    await server.close();
  }
  servers.length = 0;
});

describe('ChatStream', () => {
  it('entrega cada snapshot recebido pelo socket', async () => {
    const server = await startWsTestServer();
    servers.push(server);
    const stream = createStream(server);
    const received: string[] = [];
    stream.onSnapshot((snapshot) => {
      received.push(snapshot.conversationId);
    });

    stream.start();
    const connection = await server.waitForConnection();
    await waitForState(stream, (state) => state === 'live');

    const first = nextSnapshot(stream);
    connection.sendText(JSON.stringify({ type: 'chat', snapshot: chatSnapshot('c1') }));
    await expect(first).resolves.toMatchObject({ conversationId: 'c1' });

    const second = nextSnapshot(stream);
    connection.sendText(JSON.stringify({ type: 'chat', snapshot: chatSnapshot('c2') }));
    await expect(second).resolves.toMatchObject({ conversationId: 'c2' });

    expect(received).toEqual(['c1', 'c2']);
    expect(stream.current?.conversationId).toBe('c2');
  });

  it('ignora mensagens de tipo desconhecido', async () => {
    const server = await startWsTestServer();
    servers.push(server);
    const stream = createStream(server);
    const received: ChatSnapshot[] = [];
    stream.onSnapshot((snapshot) => {
      received.push(snapshot);
    });

    stream.start();
    const connection = await server.waitForConnection();
    await waitForState(stream, (state) => state === 'live');

    connection.sendText(JSON.stringify({ type: 'pong' }));
    connection.sendText('não é json');
    connection.sendText(JSON.stringify({ type: 'chat', snapshot: { terminalId: 't1' } }));

    const snapshot = nextSnapshot(stream);
    connection.sendText(JSON.stringify({ type: 'chat', snapshot: chatSnapshot('válido') }));
    await expect(snapshot).resolves.toMatchObject({ conversationId: 'válido' });

    expect(received).toHaveLength(1);
    expect(stream.state).toBe('live');
  });

  it('reconecta depois que o socket cai', async () => {
    const server = await startWsTestServer();
    servers.push(server);
    const stream = createStream(server, { reconnectBaseMs: 10, maxBackoffMs: 20 });

    stream.start();
    const first = await server.waitForConnection(1);
    await waitForState(stream, (state) => state === 'live');
    first.close();
    await waitForState(stream, (state) => state === 'connecting');

    const second = await server.waitForConnection(2);
    await waitForState(stream, (state) => state === 'live');

    const snapshot = nextSnapshot(stream);
    second.sendText(JSON.stringify({ type: 'chat', snapshot: chatSnapshot('depois') }));
    await expect(snapshot).resolves.toMatchObject({ conversationId: 'depois' });
  });

  it('passa a consultar por HTTP depois de falhas seguidas e volta ao socket', async () => {
    let httpRequests = 0;
    const server = await startWsTestServer({
      rejectUpgrade: (_req, attempt) => (attempt <= 3 ? 503 : undefined),
      onRequest: (req, res) => {
        if (req.method === 'GET' && req.url === '/api/terminals/t1/chat') {
          httpRequests += 1;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(chatSnapshot(`poll-${httpRequests}`)));
          return;
        }
        res.statusCode = 404;
        res.end();
      },
    });
    servers.push(server);
    const stream = createStream(server, {
      reconnectBaseMs: 10,
      maxBackoffMs: 200,
      pollIntervalMs: 10,
      pollAfterFailures: 3,
    });

    stream.start();
    await waitForState(stream, (state) => state === 'polling');
    const polled = nextSnapshot(stream);
    await expect(polled).resolves.toMatchObject({ conversationId: 'poll-1' });
    expect(httpRequests).toBeGreaterThanOrEqual(1);

    const connection = await server.waitForConnection(1);
    await waitForState(stream, (state) => state === 'live');

    const fromSocket = nextSnapshot(stream);
    connection.sendText(JSON.stringify({ type: 'chat', snapshot: chatSnapshot('socket') }));
    await expect(fromSocket).resolves.toMatchObject({ conversationId: 'socket' });
  });

  it('não deixa uma consulta HTTP antiga sobrescrever um snapshot do socket mais novo', async () => {
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const server = await startWsTestServer({
      onRequest: (req, res) => {
        if (req.method === 'GET' && req.url === '/api/terminals/t1/chat') {
          markStarted?.();
          release = () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(chatSnapshot('http-antigo')));
          };
          return;
        }
        res.statusCode = 404;
        res.end();
      },
    });
    servers.push(server);
    const stream = createStream(server);
    const received: string[] = [];
    stream.onSnapshot((snapshot) => {
      received.push(snapshot.conversationId);
    });

    stream.start();
    const connection = await server.waitForConnection();
    await waitForState(stream, (state) => state === 'live');

    const refreshing = stream.refresh();
    await started;

    const socketSnapshot = nextSnapshot(stream);
    connection.sendText(JSON.stringify({ type: 'chat', snapshot: chatSnapshot('socket-novo') }));
    await expect(socketSnapshot).resolves.toMatchObject({ conversationId: 'socket-novo' });

    release?.();
    await refreshing;

    expect(stream.current?.conversationId).toBe('socket-novo');
    expect(received).toEqual(['socket-novo']);
  });

  it('fica offline e para de tentar quando o token é recusado', async () => {
    const server = await startWsTestServer({ rejectUpgrade: () => 401 });
    servers.push(server);
    const stream = createStream(server, { reconnectBaseMs: 10, maxBackoffMs: 20 });

    stream.start();
    await waitForState(stream, (state) => state === 'offline');

    const error = stream.lastError;
    expect(isWireError(error)).toBe(true);
    if (isWireError(error)) {
      expect(error.status).toBe(401);
    }

    await delay(60);
    expect(server.upgrades).toBe(1);
    expect(stream.current).toBeUndefined();
  });

  it('descarta respostas que chegam depois do stop', async () => {
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const server = await startWsTestServer({
      onRequest: (req, res) => {
        if (req.method === 'GET' && req.url === '/api/terminals/t1/chat') {
          markStarted?.();
          release = () => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(chatSnapshot('atrasado')));
          };
          return;
        }
        res.statusCode = 404;
        res.end();
      },
    });
    servers.push(server);
    const stream = createStream(server);
    const received: ChatSnapshot[] = [];
    stream.onSnapshot((snapshot) => {
      received.push(snapshot);
    });

    stream.start();
    await server.waitForConnection();
    await waitForState(stream, (state) => state === 'live');

    const refreshing = stream.refresh();
    await started;
    stream.stop();
    release?.();
    await refreshing;

    expect(stream.state).toBe('offline');
    expect(stream.current).toBeUndefined();
    expect(received).toEqual([]);
  });

  it('apply sempre aplica e isola listeners que lançam', () => {
    const client = new WireClient({
      host: '127.0.0.1',
      port: 1,
      pin: Buffer.alloc(32).toString('base64'),
      token: 'token',
      deviceId: 'device',
      deviceName: 'Test',
      role: 'owner',
    });
    const stream = new ChatStream({ client, terminalId: 't1' });
    const received: string[] = [];

    stream.onSnapshot(() => {
      throw new Error('listener quebrado');
    });
    stream.onSnapshot((snapshot) => {
      received.push(snapshot.conversationId);
    });

    stream.apply(chatSnapshot('aplicado'));

    expect(received).toEqual(['aplicado']);
    expect(stream.current?.conversationId).toBe('aplicado');
  });
});
