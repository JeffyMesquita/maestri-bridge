import { afterEach, describe, expect, it } from 'vitest';
import { isWireError } from '../src/errors.ts';
import type { WireError } from '../src/errors.ts';
import { WireSocket } from '../src/ws.ts';
import type { WireSocketCloseReason, WireSocketOptions } from '../src/ws.ts';
import { startTestServer, startWsTestServer } from './helpers/test-server.ts';
import type { TestServer } from './helpers/test-server.ts';

const servers: TestServer[] = [];
const sockets: WireSocket[] = [];

async function open(
  server: TestServer,
  overrides: Partial<WireSocketOptions> = {},
): Promise<WireSocket> {
  const socket = await WireSocket.connect(
    { host: server.host, port: server.port, pin: server.pin },
    { path: '/chat', token: 'token-123', timeoutMs: 2000, ...overrides },
  );
  sockets.push(socket);
  return socket;
}

function firstClose(socket: WireSocket): Promise<WireSocketCloseReason> {
  return new Promise<WireSocketCloseReason>((resolve) => {
    socket.onClose(resolve);
  });
}

function firstText(socket: WireSocket): Promise<string> {
  return new Promise<string>((resolve) => {
    socket.onText(resolve);
  });
}

function expectWireError(error: unknown): WireError {
  if (!isWireError(error)) {
    throw new Error('Expected a WireError.');
  }
  return error;
}

afterEach(async () => {
  for (const socket of sockets) {
    socket.close();
  }
  sockets.length = 0;
  for (const server of servers) {
    await server.close();
  }
  servers.length = 0;
});

describe('WireSocket', () => {
  it('envia o token na query do upgrade', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server, { path: '/chat?x=1', token: 'a b' });
    const connection = await server.waitForConnection();

    expect(connection.request.url).toBe('/chat?x=1&token=a%20b');
    socket.close();
  });

  it('envia texto do cliente em frame mascarado', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    const connection = await server.waitForConnection();
    socket.sendText('Olá, Maestri');

    const frame = await connection.waitForFrame((item) => item.opcode === 0x1);
    expect(frame.masked).toBe(true);
    expect(frame.payload.toString('utf8')).toBe('Olá, Maestri');
  });

  it('entrega uma mensagem de texto fragmentada em vários frames', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    const connection = await server.waitForConnection();
    const text = firstText(socket);
    connection.sendFragmentedText(['Olá', ', ', 'mundo']);

    await expect(text).resolves.toBe('Olá, mundo');
  });

  it('ignora frames binários', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    const connection = await server.waitForConnection();
    const text = firstText(socket);
    connection.sendFrame({ opcode: 0x2, payload: Buffer.from('binário') });
    connection.sendText('texto');

    await expect(text).resolves.toBe('texto');
  });

  it('entrega texto com payload de 16 bits', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    const connection = await server.waitForConnection();
    const long = 'x'.repeat(300);
    const text = firstText(socket);
    connection.sendText(long);

    await expect(text).resolves.toBe(long);
  });

  it('monta frames que chegam em pedaços', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    const connection = await server.waitForConnection();
    const payload = Buffer.from('partido');
    const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    const text = firstText(socket);

    connection.sendRaw(frame.subarray(0, 3));
    await new Promise((resolve) => setTimeout(resolve, 10));
    connection.sendRaw(frame.subarray(3));

    await expect(text).resolves.toBe('partido');
  });

  it('responde ping com pong', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    const connection = await server.waitForConnection();
    const pong = connection.waitForFrame((item) => item.opcode === 0xa);
    connection.sendPing(Buffer.from('vivo'));

    const frame = await pong;
    expect(frame.masked).toBe(true);
    expect(frame.payload.toString('utf8')).toBe('vivo');
  });

  it('recusa o servidor se o Sec-WebSocket-Accept não confere', async () => {
    const server = await startWsTestServer({ accept: 'valor-errado' });
    servers.push(server);

    const error = expectWireError(await open(server).catch((reason: unknown) => reason));
    expect(error.code).toBe('protocolMismatch');
    expect(error.messageId).toBe('socketHandshakeFailed');
  });

  it('usa o status do handshake quando o servidor recusa o upgrade', async () => {
    const server = await startTestServer(
      (_req, res) => {
        res.end();
      },
      {
        onUpgrade: (_req, socket) => {
          socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
          socket.end();
        },
      },
    );
    servers.push(server);

    const error = expectWireError(await open(server).catch((reason: unknown) => reason));
    expect(error.code).toBe('unauthorized');
    expect(error.status).toBe(401);
  });

  it('recusa a conexão quando a chave fixada não confere', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const wrongPin = Buffer.alloc(32, 7).toString('base64');
    const error = expectWireError(
      await WireSocket.connect(
        { host: server.host, port: server.port, pin: wrongPin },
        { path: '/chat', token: 'token-123', timeoutMs: 2000 },
      ).catch((reason: unknown) => reason),
    );

    expect(error.code).toBe('pinMismatch');
    expect(server.upgrades).toBe(0);
    expect(server.requests).toBe(0);
  });

  it('fecha quando o servidor não responde ping', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server, { pingIntervalMs: 20, pongTimeoutMs: 20 });
    const closed = firstClose(socket);
    const reason = await closed;

    expect(reason.error?.code).toBe('timeout');
    expect(reason.error?.messageId).toBe('requestTimeout');
    expect(socket.isOpen).toBe(false);
  });

  it('responde close do servidor e entrega código e motivo', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    const connection = await server.waitForConnection();
    const closed = firstClose(socket);
    connection.sendClose(1001, 'tchau');

    const reason = await closed;
    expect(reason.code).toBe(1001);
    expect(reason.reason).toBe('tchau');

    const reply = await connection.waitForFrame((item) => item.opcode === 0x8);
    expect(reply.masked).toBe(true);
    expect(reply.payload.readUInt16BE(0)).toBe(1001);
  });

  it('fecha com 1002 quando o servidor manda frame mascarado', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    const connection = await server.waitForConnection();
    const closed = firstClose(socket);
    connection.sendFrame({ opcode: 0x1, payload: Buffer.from('x'), masked: true });

    const reason = await closed;
    expect(reason.error?.code).toBe('protocolMismatch');
    expect(reason.error?.messageId).toBe('socketHandshakeFailed');

    const closeFrame = await connection.waitForFrame((item) => item.opcode === 0x8);
    expect(closeFrame.payload.readUInt16BE(0)).toBe(1002);
  });

  it('fecha com 1009 quando a mensagem passa do limite', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server, { maxMessageBytes: 8 });
    const connection = await server.waitForConnection();
    const closed = firstClose(socket);
    connection.sendFragmentedText(['12345', '6789']);

    const reason = await closed;
    expect(reason.error?.code).toBe('payloadTooLarge');
    expect(reason.error?.messageId).toBe('responseTooLarge');

    const closeFrame = await connection.waitForFrame((item) => item.opcode === 0x8);
    expect(closeFrame.payload.readUInt16BE(0)).toBe(1009);
  });

  it('envia close 1000 ao fechar pelo cliente', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    const connection = await server.waitForConnection();
    const closed = firstClose(socket);
    socket.close();

    const closeFrame = await connection.waitForFrame((item) => item.opcode === 0x8);
    expect(closeFrame.payload.readUInt16BE(0)).toBe(1000);
    await closed;
  });

  it('dispara onClose uma única vez', async () => {
    const server = await startWsTestServer();
    servers.push(server);

    const socket = await open(server);
    await server.waitForConnection();
    let count = 0;
    const closed = new Promise<void>((resolve) => {
      socket.onClose(() => {
        count += 1;
        resolve();
      });
    });

    socket.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(count).toBe(1);
  });
});
