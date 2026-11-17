import { isWireError, WireError } from './errors.ts';
import { wireRequest, wireRequestBytes } from './http.ts';
import type { WireRequestOptions } from './http.ts';
import {
  parseChatHistory,
  parseChatSnapshot,
  parseChatThreadPreviews,
  parseMentions,
  parseStagedAttachment,
  parseTerminalFileIndex,
} from './chat.ts';
import type {
  ChatHistory,
  ChatMention,
  ChatSnapshot,
  ChatThreadPreview,
  PromptSegment,
  StagedAttachment,
  TerminalFileIndex,
} from './chat.ts';
import { parseFeed, parseHostInfo, parseWorkspaces } from './models.ts';
import { parseSavedPrompts } from './saved-prompts.ts';
import type { SavedPrompt } from './saved-prompts.ts';
import type { FeedSnapshot, HostInfo, WorkspaceSummary } from './models.ts';
import type { Credentials } from './types.ts';
import { WireSocket } from './ws.ts';

export interface WireClientOptions {
  timeoutMs?: number;
}

export class WireClient {
  private readonly credentials: Credentials;
  private readonly options: WireClientOptions;

  constructor(credentials: Credentials, options?: WireClientOptions) {
    this.credentials = credentials;
    this.options = options ?? {};
  }

  async info(): Promise<HostInfo> {
    const raw = await this.request<unknown>({ method: 'GET', path: '/api/info' });
    const info = parseHostInfo(raw);
    if (info.protocolVersion !== 1) {
      throw new WireError({
        code: 'protocolMismatch',
        message: 'Unsupported Maestri protocol version.',
        messageId: 'unsupportedProtocol',
      });
    }
    return info;
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const raw = await this.request<unknown>({ method: 'GET', path: '/api/workspaces' });
    return parseWorkspaces(raw).filter((workspace) => !workspace.isLocked);
  }

  async getFeed(workspaceId: string, floor?: string): Promise<FeedSnapshot> {
    const raw = await this.request<unknown>({
      method: 'GET',
      path: `/api/workspaces/${encodeURIComponent(workspaceId)}/feed`,
      query: floor === undefined ? undefined : { floor },
    });
    return parseFeed(raw);
  }

  async sendPrompt(terminalId: string, text: string): Promise<void> {
    if (text.trim() === '') {
      throw new WireError({
        code: 'invalidRequest',
        message: 'The message is empty.',
        messageId: 'emptyMessage',
      });
    }

    try {
      await this.request({
        method: 'POST',
        path: `/api/terminals/${encodeURIComponent(terminalId)}/prompt`,
        json: { text },
      });
    } catch (error) {
      if (isWireError(error) && error.status === 409) {
        throw new WireError({
          code: 'conflict',
          status: 409,
          message: 'This terminal is not running in Maestri.',
          messageId: 'terminalNotRunning',
          cause: error,
        });
      }
      throw error;
    }
  }

  async focusTerminal(terminalId: string): Promise<void> {
    await this.request({
      method: 'POST',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/focus`,
    });
  }

  async approve(terminalId: string): Promise<void> {
    await this.respondToPrompt(terminalId, 'approve');
  }

  async reject(terminalId: string): Promise<void> {
    await this.respondToPrompt(terminalId, 'reject');
  }

  private async respondToPrompt(
    terminalId: string,
    action: 'approve' | 'reject',
  ): Promise<void> {
    try {
      await this.request({
        method: 'POST',
        path: `/api/terminals/${encodeURIComponent(terminalId)}/${action}`,
      });
    } catch (error) {
      if (isWireError(error) && error.status === 409) {
        throw new WireError({
          code: 'conflict',
          status: 409,
          message: 'This agent is not waiting for an answer.',
          messageId: 'agentNotWaiting',
          cause: error,
        });
      }
      throw error;
    }
  }

  async getChat(terminalId: string): Promise<ChatSnapshot> {
    const raw = await this.request<unknown>({
      method: 'GET',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/chat`,
    });
    return parseChatSnapshot(raw);
  }

  async openChatSocket(
    terminalId: string,
    options?: { pingIntervalMs?: number; pongTimeoutMs?: number },
  ): Promise<WireSocket> {
    return WireSocket.connect(
      { host: this.credentials.host, port: this.credentials.port, pin: this.credentials.pin },
      {
        path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/stream`,
        token: this.credentials.token,
        ...options,
      },
    );
  }

  async setChatEnabled(terminalId: string, enabled: boolean): Promise<ChatSnapshot> {
    const raw = await this.request<unknown>({
      method: 'PUT',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/chat`,
      json: { enabled },
    });
    return parseChatSnapshot(raw);
  }

  async selectChatThread(terminalId: string, slot: number): Promise<ChatSnapshot> {
    const raw = await this.withChatConflict(
      this.request<unknown>({
        method: 'PUT',
        path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/thread`,
        json: { slot },
      }),
    );
    return parseChatSnapshot(raw);
  }

  async clearChatThread(terminalId: string, slot: number): Promise<void> {
    await this.withChatConflict(
      this.request({
        method: 'DELETE',
        path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/thread`,
        json: { slot },
      }),
    );
  }

  async getChatThreadPreviews(terminalId: string): Promise<ChatThreadPreview[]> {
    const raw = await this.request<unknown>({
      method: 'GET',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/threads`,
    });
    return parseChatThreadPreviews(raw);
  }

  async getChatHistory(terminalId: string): Promise<ChatHistory> {
    const raw = await this.request<unknown>({
      method: 'GET',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/history`,
    });
    return parseChatHistory(raw);
  }

  async loadOlderChat(
    terminalId: string,
    conversationId: string,
    beforeEntryId: string,
  ): Promise<void> {
    await this.request({
      method: 'POST',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/history`,
      json: { conversationId, beforeEntryId },
    });
  }

  async markChatRead(terminalId: string): Promise<void> {
    await this.request({
      method: 'POST',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/read`,
    });
  }

  async deleteChatEntry(terminalId: string, entryId: string): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/entries/${encodeURIComponent(entryId)}`,
    });
  }

  async clearChatHistory(terminalId: string): Promise<void> {
    await this.withChatConflict(
      this.request({
        method: 'DELETE',
        path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/history`,
      }),
    );
  }

  async downloadChatAttachment(
    terminalId: string,
    attachmentId: string,
  ): Promise<{ body: Buffer; contentType?: string }> {
    return this.requestBytes({
      method: 'GET',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/chat/attachments/${encodeURIComponent(attachmentId)}`,
    });
  }

  async stageAttachment(
    terminalId: string,
    fileName: string,
    body: Buffer,
    contentType: string,
  ): Promise<StagedAttachment> {
    const raw = await this.request<unknown>({
      method: 'POST',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/attachments`,
      query: { filename: fileName },
      body,
      contentType,
    });
    return parseStagedAttachment(raw);
  }

  async discardAttachment(terminalId: string, attachmentId: string): Promise<void> {
    await this.request({
      method: 'DELETE',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/attachments/${encodeURIComponent(attachmentId)}`,
    });
  }

  async sendPromptSegments(
    terminalId: string,
    segments: PromptSegment[],
    clientMessageId?: string,
  ): Promise<void> {
    if (!hasPromptContent(segments)) {
      throw new WireError({
        code: 'invalidRequest',
        message: 'The message is empty.',
        messageId: 'emptyMessage',
      });
    }

    const payload: { segments: PromptSegment[]; clientMessageId?: string } = { segments };
    if (clientMessageId !== undefined) {
      payload.clientMessageId = clientMessageId;
    }

    try {
      await this.request({
        method: 'POST',
        path: `/api/terminals/${encodeURIComponent(terminalId)}/prompt`,
        json: payload,
      });
    } catch (error) {
      if (isWireError(error) && error.status === 409) {
        throw new WireError({
          code: 'conflict',
          status: 409,
          message: 'This terminal is not running in Maestri.',
          messageId: 'terminalNotRunning',
          cause: error,
        });
      }
      throw error;
    }
  }

  async listMentions(terminalId: string): Promise<ChatMention[]> {
    const raw = await this.request<unknown>({
      method: 'GET',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/mentions`,
    });
    return parseMentions(raw);
  }

  async listSavedPrompts(): Promise<SavedPrompt[]> {
    const raw = await this.request<unknown>({
      method: 'GET',
      path: '/api/prompts',
    });
    return parseSavedPrompts(raw);
  }

  async listTerminalFiles(
    terminalId: string,
    options: { query?: string; scope?: string; limit?: number },
  ): Promise<TerminalFileIndex> {
    const raw = await this.request<unknown>({
      method: 'GET',
      path: `/api/terminals/${encodeURIComponent(terminalId)}/files`,
      query: { query: options.query, scope: options.scope, limit: options.limit },
    });
    return parseTerminalFileIndex(raw);
  }

  private async withChatConflict<T>(request: Promise<T>): Promise<T> {
    try {
      return await request;
    } catch (error) {
      if (isWireError(error) && error.status === 409) {
        throw new WireError({
          code: 'conflict',
          status: 409,
          message: 'Maestri is busy with this chat right now.',
          messageId: 'chatBusy',
          cause: error,
        });
      }
      throw error;
    }
  }

  private request<T = unknown>(options: WireRequestOptions): Promise<T> {
    return wireRequest<T>(
      { host: this.credentials.host, port: this.credentials.port, pin: this.credentials.pin },
      {
        ...options,
        token: this.credentials.token,
        timeoutMs: this.options.timeoutMs,
      },
    );
  }

  private requestBytes(
    options: WireRequestOptions,
  ): Promise<{ body: Buffer; contentType?: string }> {
    return wireRequestBytes(
      { host: this.credentials.host, port: this.credentials.port, pin: this.credentials.pin },
      {
        ...options,
        token: this.credentials.token,
        timeoutMs: this.options.timeoutMs,
      },
    );
  }
}

function hasPromptContent(segments: readonly PromptSegment[]): boolean {
  return segments.some((segment) =>
    'attachmentId' in segment
      ? segment.attachmentId.trim() !== ''
      : segment.text.trim() !== '',
  );
}
