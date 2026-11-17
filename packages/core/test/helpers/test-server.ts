import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import selfsigned from 'selfsigned';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface TestServerOptions {
  keyType?: 'rsa' | 'ec';
  onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

export interface TestServer {
  host: string;
  port: number;
  pin: string;
  readonly requests: number;
  close(): Promise<void>;
}

export async function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  options: TestServerOptions = {},
): Promise<TestServer> {
  const keyType = options.keyType ?? 'ec';
  const notAfterDate = new Date();
  notAfterDate.setDate(notAfterDate.getDate() + 1);

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keyType,
    ...(keyType === 'ec' ? { curve: 'P-256' as const } : { keySize: 2048 }),
    algorithm: 'sha256',
    notAfterDate,
  });

  let requests = 0;
  const upgradeSockets = new Set<Duplex>();
  const server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    requests += 1;
    handler(req, res);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgradeSockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      upgradeSockets.delete(socket);
    });
    if (options.onUpgrade === undefined) {
      socket.destroy();
      return;
    }
    options.onUpgrade(req, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Não foi possível iniciar o servidor de teste.');
  }

  const certificate = new X509Certificate(pems.cert);
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const pin = createHash('sha256').update(spki).digest('base64');

  return {
    host: '127.0.0.1',
    port: address.port,
    pin,
    get requests() {
      return requests;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        for (const socket of upgradeSockets) {
          socket.destroy();
        }
        upgradeSockets.clear();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  masked: boolean;
}

export interface WsConnection {
  readonly request: IncomingMessage;
  readonly frames: readonly WsFrame[];
  sendText(text: string): void;
  sendFragmentedText(parts: readonly string[]): void;
  sendPing(payload?: Buffer): void;
  sendPong(payload?: Buffer): void;
  sendClose(code?: number, reason?: string): void;
  sendFrame(options: {
    fin?: boolean;
    opcode: number;
    payload?: Buffer;
    masked?: boolean;
  }): void;
  sendRaw(bytes: Buffer): void;
  waitForFrame(predicate: (frame: WsFrame) => boolean, timeoutMs?: number): Promise<WsFrame>;
  waitForClose(timeoutMs?: number): Promise<void>;
  close(): void;
}

export interface WsTestServerOptions {
  accept?: string;
  onRequest?: (req: IncomingMessage, res: ServerResponse) => void;
  rejectUpgrade?: (req: IncomingMessage, attempt: number) => number | undefined;
  onConnection?: (connection: WsConnection) => void;
}

export interface WsTestServer extends TestServer {
  readonly connection: WsConnection | undefined;
  readonly connections: readonly WsConnection[];
  readonly upgrades: number;
  waitForConnection(count?: number): Promise<WsConnection>;
}

export async function startWsTestServer(
  options: WsTestServerOptions = {},
): Promise<WsTestServer> {
  let upgrades = 0;
  const connections: WsConnection[] = [];
  const waiters: Array<{ count: number; resolve: (value: WsConnection) => void }> = [];

  const resolveWaiters = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || connections.length < waiter.count) {
        continue;
      }
      const value = connections[waiter.count - 1];
      if (value === undefined) {
        continue;
      }
      waiters.splice(index, 1);
      waiter.resolve(value);
    }
  };

  const waitForConnection = (count = 1): Promise<WsConnection> => {
    const existing = connections[count - 1];
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise<WsConnection>((resolve) => {
      waiters.push({ count, resolve });
    });
  };

  const base = await startTestServer(
    (req, res) => {
      if (options.onRequest !== undefined) {
        options.onRequest(req, res);
        return;
      }
      res.statusCode = 404;
      res.end();
    },
    {
      onUpgrade: (req, socket, head) => {
        upgrades += 1;
        const rejectStatus = options.rejectUpgrade?.(req, upgrades);
        if (rejectStatus !== undefined) {
          socket.write(`HTTP/1.1 ${rejectStatus} Rejected\r\nContent-Length: 0\r\n\r\n`);
          socket.end();
          return;
        }

        const key = String(req.headers['sec-websocket-key'] ?? '');
        const accept =
          options.accept ?? createHash('sha1').update(key + WS_GUID).digest('base64');
        socket.write(
          [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '',
            '',
          ].join('\r\n'),
        );

        const created = createWsConnection(req, socket);
        connections.push(created);
        resolveWaiters();
        if (head.length > 0) {
          created.feed(head);
        }
        options.onConnection?.(created);
      },
    },
  );

  return {
    host: base.host,
    port: base.port,
    pin: base.pin,
    get requests() {
      return base.requests;
    },
    get upgrades() {
      return upgrades;
    },
    get connection() {
      return connections.at(-1);
    },
    get connections() {
      return [...connections];
    },
    waitForConnection,
    close() {
      return base.close();
    },
  };
}

interface InternalWsConnection extends WsConnection {
  feed(chunk: Buffer): void;
}

interface FrameWaiter {
  predicate: (frame: WsFrame) => boolean;
  resolve: (frame: WsFrame) => void;
}

function createWsConnection(request: IncomingMessage, socket: Duplex): InternalWsConnection {
  const frames: WsFrame[] = [];
  const waiters: FrameWaiter[] = [];
  let buffer: Buffer = Buffer.alloc(0);
  let closed = false;

  const notifyClose = (): void => {
    closed = true;
  };
  socket.once('close', notifyClose);
  socket.once('end', notifyClose);

  const parse = (): void => {
    while (true) {
      const parsed = readClientFrame(buffer);
      if (parsed === undefined) {
        return;
      }
      buffer = buffer.subarray(parsed.size);
      frames.push(parsed.frame);

      if (parsed.frame.opcode === 0x8) {
        echoClose(socket, parsed.frame.payload);
      }

      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter !== undefined && waiter.predicate(parsed.frame)) {
          waiters.splice(index, 1);
          waiter.resolve(parsed.frame);
        }
      }
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    parse();
  });

  const connection: InternalWsConnection = {
    request,
    get frames() {
      return frames;
    },
    feed(chunk: Buffer): void {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      parse();
    },
    sendText(text: string): void {
      connection.sendFrame({ opcode: 0x1, payload: Buffer.from(text, 'utf8') });
    },
    sendFragmentedText(parts: readonly string[]): void {
      if (parts.length === 0) {
        connection.sendFrame({ opcode: 0x1, payload: Buffer.alloc(0) });
        return;
      }
      parts.forEach((part, index) => {
        const last = index === parts.length - 1;
        connection.sendFrame({
          fin: last,
          opcode: index === 0 ? 0x1 : 0x0,
          payload: Buffer.from(part, 'utf8'),
        });
      });
    },
    sendPing(payload?: Buffer): void {
      connection.sendFrame({ opcode: 0x9, payload: payload ?? Buffer.alloc(0) });
    },
    sendPong(payload?: Buffer): void {
      connection.sendFrame({ opcode: 0xa, payload: payload ?? Buffer.alloc(0) });
    },
    sendClose(code?: number, reason?: string): void {
      const reasonBytes = Buffer.from(reason ?? '', 'utf8');
      const payload = Buffer.alloc(2 + reasonBytes.length);
      payload.writeUInt16BE(code ?? 1000, 0);
      reasonBytes.copy(payload, 2);
      connection.sendFrame({ opcode: 0x8, payload });
    },
    sendFrame(options): void {
      socket.write(
        encodeServerFrame(
          options.opcode,
          options.payload ?? Buffer.alloc(0),
          options.masked ?? false,
          options.fin ?? true,
        ),
      );
    },
    sendRaw(bytes: Buffer): void {
      socket.write(bytes);
    },
    waitForFrame(predicate: (frame: WsFrame) => boolean, timeoutMs = 2000): Promise<WsFrame> {
      const existing = frames.find(predicate);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise<WsFrame>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const waiter: FrameWaiter = {
          predicate,
          resolve: (frame) => {
            if (timer !== undefined) {
              clearTimeout(timer);
            }
            resolve(frame);
          },
        };

        timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(new Error('Timed out waiting for a WebSocket frame.'));
        }, timeoutMs);

        waiters.push(waiter);
      });
    },
    waitForClose(timeoutMs = 2000): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Timed out waiting for the WebSocket to close.'));
        }, timeoutMs);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        socket.once('close', done);
        socket.once('end', done);
      });
    },
    close(): void {
      socket.destroy();
    },
  };

  return connection;
}

function echoClose(socket: Duplex, payload: Buffer): void {
  const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
  const reply = Buffer.alloc(2);
  reply.writeUInt16BE(code, 0);
  socket.write(encodeServerFrame(0x8, reply, false, true));
  socket.end();
}

interface ParsedClientFrame {
  frame: WsFrame;
  size: number;
}

function readClientFrame(buffer: Buffer): ParsedClientFrame | undefined {
  if (buffer.length < 2) {
    return undefined;
  }

  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) {
      return undefined;
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return undefined;
    }
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskOffset = offset;
  if (masked) {
    offset += 4;
  }
  if (buffer.length < offset + length) {
    return undefined;
  }

  const mask = masked ? buffer.subarray(maskOffset, maskOffset + 4) : undefined;
  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    const byte = buffer[offset + index] ?? 0;
    payload[index] = mask === undefined ? byte : byte ^ (mask[index % 4] ?? 0);
  }

  return { frame: { fin, opcode, payload, masked }, size: offset + length };
}

function encodeServerFrame(
  opcode: number,
  payload: Buffer,
  masked: boolean,
  fin: boolean,
): Buffer {
  const first = (fin ? 0x80 : 0) | opcode;
  const maskBit = masked ? 0x80 : 0;
  let header: Buffer;

  if (payload.length < 126) {
    header = Buffer.from([first, maskBit | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = maskBit | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  if (!masked) {
    return Buffer.concat([header, payload]);
  }

  const mask = randomBytes(4);
  const maskedPayload = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    maskedPayload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, mask, maskedPayload]);
}
