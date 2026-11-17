import { createHash, randomBytes } from 'node:crypto';
import { isIPv6 } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { codeForStatus, WireError } from './errors.ts';
import { connectPinned } from './tls.ts';
import type { PinnedHost } from './types.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_PING_INTERVAL_MS = 20000;
const DEFAULT_PONG_TIMEOUT_MS = 10000;
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const FORCE_CLOSE_MS = 1000;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WireSocketOptions {
  path: string;
  token: string;
  timeoutMs?: number;
  maxMessageBytes?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export type WireSocketCloseReason = {
  code?: number;
  reason?: string;
  error?: WireError;
};

interface ServerFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

type FrameRead =
  | { kind: 'incomplete' }
  | { kind: 'frame'; frame: ServerFrame; size: number }
  | { kind: 'tooLarge' }
  | { kind: 'protocol' };

export class WireSocket {
  private readonly textListeners = new Set<(text: string) => void>();
  private readonly closeListeners = new Set<(reason: WireSocketCloseReason) => void>();
  private readonly maxMessageBytes: number;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private buffer: Buffer;
  private fragments: Buffer[] = [];
  private fragmentedOpcode: 0x1 | 0x2 | undefined;
  private fragmentBytes = 0;
  private open = true;
  private closeEmitted = false;
  private closeSent = false;
  private pingTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private forceCloseTimer: NodeJS.Timeout | undefined;

  private readonly onData = (chunk: Buffer): void => {
    this.handleData(chunk);
  };

  private readonly onError = (error: Error): void => {
    this.terminate({ error: networkError(this.target, error) });
  };

  private readonly onEnd = (): void => {
    this.finish({});
    this.socket.destroy();
  };

  private readonly onSocketClose = (): void => {
    this.finish({});
  };

  private constructor(
    private readonly socket: TLSSocket,
    private readonly target: PinnedHost,
    options: WireSocketOptions,
    initial: Buffer,
  ) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.buffer = initial;

    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('end', this.onEnd);
    socket.on('close', this.onSocketClose);
    this.startHeartbeat();

    if (initial.length > 0) {
      setImmediate(() => {
        if (!this.closeEmitted) {
          this.parseFrames();
        }
      });
    }
  }

  static async connect(target: PinnedHost, options: WireSocketOptions): Promise<WireSocket> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { socket } = await connectPinned(target, { timeoutMs });

    try {
      const key = randomBytes(16).toString('base64');
      socket.write(buildUpgradeRequest(target, options, key));
      const initial = await readHandshake(socket, target, key, timeoutMs);
      return new WireSocket(socket, target, options, initial);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  get isOpen(): boolean {
    return this.open && !this.closeEmitted;
  }

  onText(listener: (text: string) => void): () => void {
    this.textListeners.add(listener);
    return () => {
      this.textListeners.delete(listener);
    };
  }

  onClose(listener: (reason: WireSocketCloseReason) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  sendText(text: string): void {
    if (!this.isOpen) {
      return;
    }
    this.writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  close(code = 1000): void {
    if (this.closeEmitted || this.closeSent) {
      return;
    }
    this.open = false;
    this.stopHeartbeat();
    this.sendCloseFrame(code);
    this.forceCloseTimer = setTimeout(() => {
      this.forceCloseTimer = undefined;
      this.terminate({});
    }, FORCE_CLOSE_MS);
  }

  private handleData(chunk: Buffer): void {
    if (this.closeEmitted) {
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  }

  private parseFrames(): void {
    while (!this.closeEmitted) {
      const read = readFrame(this.buffer, this.maxMessageBytes);
      if (read.kind === 'incomplete') {
        return;
      }
      if (read.kind === 'tooLarge') {
        this.closeWithFrame({ error: tooLargeError() }, 1009);
        return;
      }
      if (read.kind === 'protocol') {
        this.closeWithFrame({ error: handshakeError() }, 1002);
        return;
      }

      this.buffer = this.buffer.subarray(read.size);
      this.markAlive();
      this.handleFrame(read.frame);
    }
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.opcode) {
      case OP_TEXT:
      case OP_BINARY:
        this.handleDataFrame(frame);
        return;
      case OP_CONTINUATION:
        this.handleContinuation(frame);
        return;
      case OP_CLOSE:
        this.handleClose(frame.payload);
        return;
      case OP_PING:
        this.writeFrame(OP_PONG, frame.payload);
        return;
      case OP_PONG:
        return;
      default:
        this.closeWithFrame({ error: handshakeError() }, 1002);
    }
  }

  private handleDataFrame(frame: ServerFrame): void {
    if (this.fragmentedOpcode !== undefined) {
      this.closeWithFrame({ error: handshakeError() }, 1002);
      return;
    }

    if (!frame.fin) {
      this.fragmentedOpcode = frame.opcode === OP_TEXT ? OP_TEXT : OP_BINARY;
      this.fragments = frame.opcode === OP_TEXT ? [frame.payload] : [];
      this.fragmentBytes = frame.payload.length;
      return;
    }

    if (frame.opcode === OP_TEXT) {
      this.emitText(frame.payload.toString('utf8'));
    }
  }

  private handleContinuation(frame: ServerFrame): void {
    if (this.fragmentedOpcode === undefined) {
      this.closeWithFrame({ error: handshakeError() }, 1002);
      return;
    }

    this.fragmentBytes += frame.payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) {
      this.closeWithFrame({ error: tooLargeError() }, 1009);
      return;
    }

    if (this.fragmentedOpcode === OP_TEXT) {
      this.fragments.push(frame.payload);
    }

    if (!frame.fin) {
      return;
    }

    const opcode = this.fragmentedOpcode;
    const fragments = this.fragments;
    this.fragmentedOpcode = undefined;
    this.fragments = [];
    this.fragmentBytes = 0;

    if (opcode === OP_TEXT) {
      this.emitText(Buffer.concat(fragments).toString('utf8'));
    }
  }

  private handleClose(payload: Buffer): void {
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
    const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : undefined;

    if (!this.closeSent) {
      this.sendCloseFrame(code ?? 1000);
    }

    const closeReason: WireSocketCloseReason = {};
    if (code !== undefined) {
      closeReason.code = code;
    }
    if (reason !== undefined) {
      closeReason.reason = reason;
    }

    this.finish(closeReason);
    this.socket.end();
  }

  private emitText(text: string): void {
    if (!this.isOpen) {
      return;
    }
    for (const listener of this.textListeners) {
      listener(text);
    }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) {
      return;
    }
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch {
      this.terminate({});
    }
  }

  private sendCloseFrame(code: number): void {
    if (this.closeSent) {
      return;
    }
    this.closeSent = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.writeFrame(OP_CLOSE, payload);
  }

  private closeWithFrame(reason: WireSocketCloseReason, code: number): void {
    if (this.closeEmitted) {
      return;
    }
    this.sendCloseFrame(code);
    this.finish(reason);
    this.socket.end();
  }

  private terminate(reason: WireSocketCloseReason): void {
    if (this.closeEmitted) {
      return;
    }
    this.finish(reason);
    this.socket.destroy();
  }

  private finish(reason: WireSocketCloseReason): void {
    if (this.closeEmitted) {
      return;
    }
    this.closeEmitted = true;
    this.open = false;
    this.clearTimers();
    this.detach();

    for (const listener of this.closeListeners) {
      listener(reason);
    }
    this.closeListeners.clear();
    this.textListeners.clear();
  }

  private detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onSocketClose);
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, this.pingIntervalMs);
  }

  private sendPing(): void {
    if (!this.isOpen) {
      return;
    }
    this.writeFrame(OP_PING, Buffer.alloc(0));
    if (this.pongTimer === undefined) {
      this.pongTimer = setTimeout(() => {
        this.pongTimer = undefined;
        this.terminate({ error: timeoutError() });
      }, this.pongTimeoutMs);
    }
  }

  private markAlive(): void {
    if (this.pongTimer !== undefined) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.pongTimer !== undefined) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.forceCloseTimer !== undefined) {
      clearTimeout(this.forceCloseTimer);
      this.forceCloseTimer = undefined;
    }
  }
}

function buildUpgradeRequest(target: PinnedHost, options: WireSocketOptions, key: string): string {
  const separator = options.path.includes('?') ? '&' : '?';
  const path = `${options.path}${separator}token=${encodeURIComponent(options.token)}`;
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${formatHostHeader(target)}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${key}`,
    '',
    '',
  ].join('\r\n');
}

function readHandshake(
  socket: TLSSocket,
  target: PinnedHost,
  key: string,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
    };

    const fail = (error: WireError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onData = (chunk: Buffer): void => {
      if (settled) {
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buffer.length > MAX_HANDSHAKE_BYTES) {
          fail(handshakeError());
        }
        return;
      }

      const header = buffer.subarray(0, headerEnd).toString('latin1');
      const rest = buffer.subarray(headerEnd + 4);
      const status = parseStatusLine(header);
      if (status === undefined) {
        fail(handshakeError());
        return;
      }
      if (status !== 101) {
        fail(
          new WireError({
            code: codeForStatus(status),
            status,
            message: `The Maestri WebSocket upgrade was rejected with status ${status}.`,
          }),
        );
        return;
      }
      if (!acceptMatches(header, key)) {
        fail(handshakeError());
        return;
      }

      settled = true;
      cleanup();
      resolve(rest);
    };

    const onError = (error: Error): void => {
      fail(networkError(target, error));
    };

    const onEnd = (): void => {
      fail(handshakeError());
    };

    timer = setTimeout(() => {
      fail(timeoutError());
    }, timeoutMs);

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
  });
}

function acceptMatches(header: string, key: string): boolean {
  const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
  return headerValue(header, 'sec-websocket-accept') === expected;
}

function headerValue(header: string, name: string): string | undefined {
  const lines = header.split('\r\n');
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    if (line.slice(0, separator).trim().toLowerCase() === name) {
      return line.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function parseStatusLine(header: string): number | undefined {
  const [statusLine = ''] = header.split('\r\n');
  const match = /^HTTP\/1\.1\s+(\d{3})(?:\s|$)/.exec(statusLine);
  if (match === null) {
    return undefined;
  }
  return Number(match[1]);
}

function readFrame(buffer: Buffer, maxMessageBytes: number): FrameRead {
  if (buffer.length < 2) {
    return { kind: 'incomplete' };
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
      return { kind: 'incomplete' };
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return { kind: 'incomplete' };
    }
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { kind: 'tooLarge' };
    }
    length = Number(big);
    offset = 10;
  }

  if (masked) {
    return { kind: 'protocol' };
  }
  if (!isKnownOpcode(opcode)) {
    return { kind: 'protocol' };
  }
  if (isControlOpcode(opcode) && (!fin || length > 125)) {
    return { kind: 'protocol' };
  }
  if (length > maxMessageBytes) {
    return { kind: 'tooLarge' };
  }
  if (buffer.length < offset + length) {
    return { kind: 'incomplete' };
  }

  return {
    kind: 'frame',
    frame: { fin, opcode, payload: buffer.subarray(offset, offset + length) },
    size: offset + length,
  };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  let header: Buffer;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    const maskByte = mask[index % 4] ?? 0;
    masked[index] = (payload[index] ?? 0) ^ maskByte;
  }

  return Buffer.concat([header, mask, masked]);
}

function isKnownOpcode(opcode: number): boolean {
  return (
    opcode === OP_CONTINUATION ||
    opcode === OP_TEXT ||
    opcode === OP_BINARY ||
    opcode === OP_CLOSE ||
    opcode === OP_PING ||
    opcode === OP_PONG
  );
}

function isControlOpcode(opcode: number): boolean {
  return (opcode & 0x8) !== 0;
}

function formatHostHeader(target: PinnedHost): string {
  const host = isIPv6(target.host) ? `[${target.host}]` : target.host;
  return `${host}:${target.port}`;
}

function networkError(target: PinnedHost, cause: Error): WireError {
  return new WireError({
    code: 'network',
    message: `Could not reach Maestri at ${target.host}:${target.port}.`,
    messageId: 'unreachable',
    params: { host: target.host, port: target.port },
    cause,
  });
}

function timeoutError(): WireError {
  return new WireError({
    code: 'timeout',
    message: 'Maestri took too long to respond.',
    messageId: 'requestTimeout',
  });
}

function handshakeError(): WireError {
  return new WireError({
    code: 'protocolMismatch',
    message: 'The Maestri WebSocket handshake failed.',
    messageId: 'socketHandshakeFailed',
  });
}

function tooLargeError(): WireError {
  return new WireError({
    code: 'payloadTooLarge',
    message: 'The Maestri response is too large.',
    messageId: 'responseTooLarge',
  });
}
