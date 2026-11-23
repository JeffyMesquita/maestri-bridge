import type { ChatSnapshot } from './chat.ts';
import { parseChatSnapshot } from './chat.ts';
import type { WireClient } from './client.ts';
import { isWireError } from './errors.ts';
import type { WireSocket, WireSocketCloseReason } from './ws.ts';

export type ChatStreamState = 'connecting' | 'live' | 'polling' | 'offline';

export interface ChatStreamOptions {
  client: WireClient;
  terminalId: string;
  reconnectBaseMs?: number;
  maxBackoffMs?: number;
  pollIntervalMs?: number;
  pollAfterFailures?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export class ChatStream {
  private readonly client: WireClient;
  readonly terminalId: string;
  private readonly reconnectBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly pollIntervalMs: number;
  private readonly pollAfterFailures: number;
  private readonly pingIntervalMs: number | undefined;
  private readonly pongTimeoutMs: number | undefined;
  private currentSnapshot: ChatSnapshot | undefined;
  private currentState: ChatStreamState = 'offline';
  private currentError: unknown;
  private failures = 0;
  private generation = 0;
  private running = false;
  private socket: WireSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private socketSnapshots = 0;
  private readonly snapshotListeners = new Set<(snapshot: ChatSnapshot) => void>();
  private readonly stateListeners = new Set<
    (state: ChatStreamState, error?: unknown) => void
  >();

  constructor(options: ChatStreamOptions) {
    this.client = options.client;
    this.terminalId = options.terminalId;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.pollAfterFailures = options.pollAfterFailures ?? 3;
    this.pingIntervalMs = options.pingIntervalMs;
    this.pongTimeoutMs = options.pongTimeoutMs;
  }

  get current(): ChatSnapshot | undefined {
    return this.currentSnapshot;
  }

  get state(): ChatStreamState {
    return this.currentState;
  }

  get lastError(): unknown {
    return this.currentError;
  }

  onSnapshot(listener: (snapshot: ChatSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  onState(listener: (state: ChatStreamState, error?: unknown) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.generation += 1;
    this.failures = 0;
    this.clearReconnectTimer();
    this.clearPollTimer();
    this.setState('connecting');
    void this.connect(this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.clearReconnectTimer();
    this.clearPollTimer();
    this.closeSocket();
    this.setState('offline');
  }

  async refresh(current: () => boolean = (): boolean => true): Promise<void> {
    const generation = this.generation;
    const socketSnapshots = this.socketSnapshots;

    let snapshot: ChatSnapshot;
    try {
      snapshot = await this.client.getChat(this.terminalId);
    } catch (error) {
      if (isAuthError(error)) {
        this.goOffline(error);
      }
      throw error;
    }

    if (generation !== this.generation) {
      return;
    }
    if (this.socketSnapshots !== socketSnapshots || !current()) {
      return;
    }
    this.setSnapshot(snapshot);
  }

  apply(snapshot: ChatSnapshot): void {
    this.setSnapshot(snapshot);
  }

  private async connect(generation: number): Promise<void> {
    let socket: WireSocket;
    try {
      socket = await this.client.openChatSocket(this.terminalId, {
        pingIntervalMs: this.pingIntervalMs,
        pongTimeoutMs: this.pongTimeoutMs,
      });
    } catch (error) {
      this.handleSocketFailure(generation, error);
      return;
    }

    if (!this.isCurrent(generation)) {
      socket.close();
      return;
    }

    this.socket = socket;
    socket.onText((text) => {
      this.handleText(socket, generation, text);
    });
    socket.onClose((reason) => {
      this.handleSocketClose(socket, generation, reason);
    });

    if (!socket.isOpen) {
      this.handleSocketClose(socket, generation, {});
      return;
    }

    this.failures = 0;
    this.clearPollTimer();
    this.setState('live');
  }

  private handleText(socket: WireSocket, generation: number, text: string): void {
    if (this.socket !== socket || !this.isCurrent(generation)) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(payload) || payload.type !== 'chat') {
      return;
    }

    let snapshot: ChatSnapshot;
    try {
      snapshot = parseChatSnapshot(payload.snapshot);
    } catch {
      return;
    }

    this.socketSnapshots += 1;
    this.setSnapshot(snapshot);
  }

  private handleSocketClose(
    socket: WireSocket,
    generation: number,
    reason: WireSocketCloseReason,
  ): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    if (!this.isCurrent(generation)) {
      return;
    }
    this.handleSocketFailure(generation, reason.error);
  }

  private handleSocketFailure(generation: number, error: unknown): void {
    if (!this.isCurrent(generation)) {
      return;
    }

    if (isAuthError(error)) {
      this.goOffline(error);
      return;
    }

    this.failures += 1;
    if (this.failures >= this.pollAfterFailures) {
      this.setState('polling', error);
      this.ensurePolling(generation);
    } else {
      this.setState('connecting', error);
    }
    this.scheduleReconnect(generation);
  }

  private scheduleReconnect(generation: number): void {
    this.clearReconnectTimer();
    const exponent = Math.max(0, this.failures - 1);
    const delay = Math.min(this.reconnectBaseMs * 2 ** exponent, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.isCurrent(generation)) {
        void this.connect(generation);
      }
    }, delay);
  }

  private ensurePolling(generation: number): void {
    if (this.pollTimer !== undefined) {
      return;
    }
    this.schedulePoll(generation);
  }

  private schedulePoll(generation: number): void {
    this.clearPollTimer();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollOnce(generation);
    }, this.pollIntervalMs);
  }

  private async pollOnce(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.currentState !== 'polling') {
      return;
    }

    try {
      await this.refresh(() => this.isCurrent(generation) && this.currentState === 'polling');
    } catch (error) {
      if (this.isCurrent(generation) && this.currentState === 'polling') {
        this.setState('polling', error);
      }
    }

    if (this.isCurrent(generation) && this.currentState === 'polling') {
      this.schedulePoll(generation);
    }
  }

  private goOffline(error: unknown): void {
    this.running = false;
    this.generation += 1;
    this.clearReconnectTimer();
    this.clearPollTimer();
    this.closeSocket();
    this.setState('offline', error);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.close();
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private isCurrent(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private setSnapshot(snapshot: ChatSnapshot): void {
    this.currentSnapshot = snapshot;
    for (const listener of [...this.snapshotListeners]) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  private setState(state: ChatStreamState, error?: unknown): void {
    this.currentState = state;
    this.currentError = error;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state, error);
      } catch {}
    }
  }
}

function isAuthError(error: unknown): boolean {
  if (!isWireError(error)) {
    return false;
  }
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.code === 'unauthorized' ||
    error.code === 'forbidden'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
