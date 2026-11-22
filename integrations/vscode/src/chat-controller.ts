import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import {
  ChatStream,
  formatPrompt,
  formatReferenceHeader,
  isWireError,
} from '@maestri-bridge/core';
import type {
  ChatMention,
  ChatSnapshot,
  CodeReference,
  PromptSegment,
  SavedPrompt,
  TerminalFileEntry,
  WireClient,
} from '@maestri-bridge/core';
import type { AgentMonitor } from './agent-monitor.ts';
import { pickAgent, toAgentTarget } from './agent-picker.ts';
import {
  MAX_ATTACHMENT_BYTES,
  isImageMime,
  mimeForFileName,
  needsRestage,
  safeFileName,
} from './chat-attachments.ts';
import { catalogMentionViews, fileMentionViews, savedPromptViews } from './chat-mentions.ts';
import { isCodeFromSelection } from './chat-paste.ts';
import { parseChatFromWebview } from './chat-protocol.ts';
import type {
  ChatComposerView,
  ChatEntryView,
  ChatFromWebview,
  ChatNotice,
  ChatReferenceView,
  ChatToWebview,
  ChatViewState,
} from './chat-protocol.ts';
import { buildChatViewState, connectionFor, unconfirmedPending } from './chat-state.ts';
import type { PendingChatEntry } from './chat-state.ts';
import { collectReferences } from './editor-references.ts';
import { describeError } from './error-messages.ts';
import { showFlowError } from './flow-errors.ts';
import { currentLocale, t } from './i18n/index.ts';
import type { MessageKey } from './i18n/index.ts';
import type { ComposerSeed, ExtensionServices } from './services.ts';
import type { AgentTarget } from './target-memory.ts';
import { resolveWorkspaceFile } from './workspace-files.ts';

const IS_MAC = process.platform === 'darwin';
const MARK_READ_INTERVAL_MS = 2000;
const LOAD_OLDER_TIMEOUT_MS = 5000;
const MENTION_CACHE_MS = 60000;

const COLOR_KEYS: Record<string, MessageKey> = {
  blue: 'chat.color.blue',
  purple: 'chat.color.purple',
  pink: 'chat.color.pink',
  red: 'chat.color.red',
  orange: 'chat.color.orange',
  yellow: 'chat.color.yellow',
  green: 'chat.color.green',
  graphite: 'chat.color.graphite',
};

interface StoredReference {
  id: string;
  reference: CodeReference;
}

interface DraftAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  body: Buffer;
  uploading: boolean;
  failed: boolean;
  attachmentId?: string;
  stagedAt?: number;
  terminalId: string;
}

export interface ChatSurface {
  readonly webview: vscode.Webview;
  visible: boolean;
}

export class ChatController implements vscode.Disposable {
  private readonly services: ExtensionServices;
  private readonly monitor: AgentMonitor;
  private readonly surfaces = new Set<ChatSurface>();
  private readonly listeners: vscode.Disposable[] = [];
  private target: AgentTarget | undefined;
  private stream: ChatStream | undefined;
  private streamClient: WireClient | undefined;
  private streamTerminalId: string | undefined;
  private streamUnsubscribers: Array<() => void> = [];
  private streamVersion = 0;
  private ensureTask: Promise<void> = Promise.resolve();
  private capabilityClient: WireClient | undefined;
  private capabilityMissing = false;
  private paired = false;
  private isOwner = true;
  private message = '';
  private references: StoredReference[] = [];
  private referenceCounter = 0;
  private pending: PendingChatEntry[] = [];
  private drafts: DraftAttachment[] = [];
  private attachmentCounter = 0;
  private attachmentCache = new Map<string, string>();
  private attachmentRequests = new Set<string>();
  private mentionCache = new Map<string, { at: number; mentions: ChatMention[] }>();
  private promptCache: { at: number; prompts: SavedPrompt[] } | undefined;
  private notice: ChatNotice | undefined;
  private sending = false;
  private loadingOlder = false;
  private loadOlderFirstId: string | undefined;
  private loadingOlderTimer: NodeJS.Timeout | undefined;
  private lastEditor: vscode.TextEditor | undefined;
  private lastMarkReadAt = 0;
  private disposed = false;

  get currentTarget(): AgentTarget | undefined {
    return this.target;
  }

  constructor(
    services: ExtensionServices,
    monitor: AgentMonitor,
    private readonly onTargetChanged?: (target: AgentTarget) => void,
  ) {
    this.services = services;
    this.monitor = monitor;
    this.target = services.memory.lastTarget();
    this.lastEditor = vscode.window.activeTextEditor;

    this.listeners.push(
      services.session.onDidChangeCredentials(() => {
        void this.handleCredentialsChanged();
      }),
      monitor.onDidChange(() => {
        this.postState();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor !== undefined) {
          this.lastEditor = editor;
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('maestriBridge.language')) {
          this.postState();
        }
      }),
    );
  }

  addSurface(webview: vscode.Webview, visible: boolean): ChatSurface {
    const surface: ChatSurface = { webview, visible };
    this.surfaces.add(surface);
    if (visible) {
      void this.ensureStream();
    }
    this.postState();
    return surface;
  }

  removeSurface(surface: ChatSurface): void {
    this.surfaces.delete(surface);
    this.stopStreamIfIdle();
  }

  setVisible(surface: ChatSurface, visible: boolean): void {
    surface.visible = visible;
    if (visible) {
      void this.ensureStream();
    } else {
      this.stopStreamIfIdle();
    }
    this.postState();
  }

  async handle(raw: unknown): Promise<void> {
    const incoming = parseChatFromWebview(raw);
    if (incoming === undefined) {
      return;
    }
    try {
      await this.dispatch(incoming);
    } catch (error) {
      await this.handleError(error);
    }
  }

  async open(seed?: ComposerSeed): Promise<void> {
    if (seed?.target !== undefined) {
      this.changeTarget(seed.target);
    }

    if (seed === undefined) {
      const editor = vscode.window.activeTextEditor ?? this.lastEditor;
      if (editor !== undefined && !editor.selection.isEmpty) {
        this.addReferences(collectReferences(editor));
      }
    } else {
      if (seed.references !== undefined) {
        this.addReferences(seed.references);
      }
      if (seed.message !== undefined && this.message === '') {
        this.message = seed.message;
      }
    }

    try {
      await vscode.commands.executeCommand('maestriBridge.chat.focus');
    } catch {}
    this.post({ type: 'focusMessage' });
    this.postState();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const listener of this.listeners) {
      listener.dispose();
    }
    this.listeners.length = 0;
    this.clearLoadingOlderTimer();
    this.stopStream();
    this.surfaces.clear();
  }

  private async dispatch(incoming: ChatFromWebview): Promise<void> {
    switch (incoming.type) {
      case 'ready':
        this.postState();
        if (this.stream === undefined || this.stream.state === 'offline') {
          await this.ensureStream();
        }
        return;
      case 'pickAgent':
        await this.pickTarget();
        return;
      case 'enableChat':
        await this.enableChat();
        return;
      case 'selectThread':
        await this.selectThread(incoming.slot);
        return;
      case 'clearThread':
        await this.clearThread(incoming.slot);
        return;
      case 'clearHistory':
        await this.clearHistory();
        return;
      case 'deleteEntry':
        await this.deleteEntry(incoming.id);
        return;
      case 'loadOlder':
        await this.loadOlder();
        return;
      case 'approve':
      case 'reject':
        await this.respondToPrompt(incoming.type);
        return;
      case 'openInMaestri':
        await this.openInMaestri();
        return;
      case 'addSelection':
        this.addSelection();
        return;
      case 'removeReference':
        this.references = this.references.filter((item) => item.id !== incoming.id);
        this.postState();
        return;
      case 'messageChanged':
        this.message = incoming.message;
        return;
      case 'pasteText':
        this.pasteText(incoming);
        return;
      case 'send':
        await this.send(incoming.message);
        return;
      case 'markRead':
        await this.markRead();
        return;
      case 'dismissNotice':
        this.notice = undefined;
        this.postState();
        return;
      case 'attachFiles':
        await this.attachFiles();
        return;
      case 'pasteFile':
        await this.pasteFile(incoming);
        return;
      case 'removeAttachment':
        this.removeAttachment(incoming.id);
        return;
      case 'requestAttachment':
        await this.requestAttachment(incoming.id);
        return;
      case 'openAttachment':
        await this.openAttachment(incoming.id);
        return;
      case 'openFile':
        await this.openFile(incoming);
        return;
      case 'queryMentions':
        await this.queryMentions(incoming.query);
        return;
    }
  }

  private async pickTarget(): Promise<void> {
    if (!this.paired) {
      const client = await this.services.session.ensureClient();
      this.paired = client !== undefined;
      await this.refreshIdentity();
      if (client !== undefined) {
        await this.ensureStream();
      }
      this.postState();
      return;
    }

    const client = await this.services.session.ensureClient();
    if (client === undefined) {
      this.paired = false;
      this.postState();
      return;
    }

    const picked = await pickAgent({
      session: this.services.session,
      client,
      memory: this.services.memory,
      references: this.references.map((item) => item.reference),
      filePath: this.lastEditor?.document.uri.fsPath,
      title: t('chat.header.pickAgent'),
    });
    if (picked === undefined) {
      return;
    }
    this.changeTarget(toAgentTarget(picked));
  }

  private changeTarget(target: AgentTarget): void {
    const changed = this.target?.terminalId !== target.terminalId;
    this.target = target;
    this.onTargetChanged?.(target);
    void this.services.memory.remember(target);
    if (changed) {
      this.pending = [];
      this.clearDrafts();
      this.notice = undefined;
      this.stopStream();
      void this.ensureStream();
    }
    this.postState();
  }

  private async enableChat(): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    const client = await this.actionClient();
    if (client === undefined) {
      return;
    }
    const snapshot = await client.setChatEnabled(target.terminalId, true);
    if (this.target !== target) {
      return;
    }
    this.stream?.apply(snapshot);
    this.postState();
  }

  private async selectThread(slot: number): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    const client = await this.actionClient();
    if (client === undefined) {
      return;
    }
    const snapshot = await client.selectChatThread(target.terminalId, slot);
    if (this.target !== target) {
      return;
    }
    this.stream?.apply(snapshot);
    this.pending = [];
    this.postState();
  }

  private async clearThread(slot: number): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    const color = this.threadColor(slot) ?? 'graphite';
    const key = COLOR_KEYS[color];
    const colorName = key === undefined ? color : t(key);
    const confirmed = await this.confirm(
      t('chat.confirm.clearThread', { color: colorName, name: target.terminalName }),
      t('chat.confirm.clear'),
    );
    if (!confirmed) {
      return;
    }
    const client = await this.actionClient();
    if (client === undefined || this.target !== target) {
      return;
    }
    await client.clearChatThread(target.terminalId, slot);
  }

  private async clearHistory(): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    const confirmed = await this.confirm(
      t('chat.confirm.clearHistory', { name: target.terminalName }),
      t('chat.confirm.clear'),
    );
    if (!confirmed) {
      return;
    }
    const client = await this.actionClient();
    if (client === undefined || this.target !== target) {
      return;
    }
    await client.clearChatHistory(target.terminalId);
  }

  private async deleteEntry(id: string): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    const confirmed = await this.confirm(
      t('chat.confirm.deleteEntry'),
      t('chat.confirm.delete'),
    );
    if (!confirmed) {
      return;
    }
    const client = await this.actionClient();
    if (client === undefined || this.target !== target) {
      return;
    }
    await client.deleteChatEntry(target.terminalId, id);
  }

  private async loadOlder(): Promise<void> {
    const target = this.target;
    const snapshot = this.stream?.current;
    const first = snapshot?.entries[0];
    if (target === undefined || snapshot === undefined || first === undefined) {
      return;
    }

    const client = await this.actionClient();
    if (client === undefined) {
      return;
    }

    this.loadingOlder = true;
    this.loadOlderFirstId = first.id;
    this.clearLoadingOlderTimer();
    this.loadingOlderTimer = setTimeout(() => {
      this.loadingOlder = false;
      this.loadOlderFirstId = undefined;
      this.loadingOlderTimer = undefined;
      this.postState();
    }, LOAD_OLDER_TIMEOUT_MS);
    this.postState();

    await client.loadOlderChat(target.terminalId, snapshot.conversationId, first.id);
  }

  private async respondToPrompt(action: 'approve' | 'reject'): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    const client = await this.actionClient();
    if (client === undefined) {
      return;
    }
    if (action === 'approve') {
      await client.approve(target.terminalId);
    } else {
      await client.reject(target.terminalId);
    }
  }

  private async openInMaestri(): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    const client = await this.actionClient();
    if (client === undefined) {
      return;
    }
    await client.focusTerminal(target.terminalId);
  }

  private async attachFiles(): Promise<void> {
    const selection = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: t('chat.composer.attach'),
    });
    if (selection === undefined) {
      return;
    }

    for (const uri of selection) {
      let data: Uint8Array;
      try {
        data = await vscode.workspace.fs.readFile(uri);
      } catch (error) {
        await this.handleError(error);
        continue;
      }

      const body = Buffer.from(data);
      const name = uri.path.split('/').at(-1) ?? uri.fsPath;
      if (body.length > MAX_ATTACHMENT_BYTES) {
        this.notice = { kind: 'error', text: t('chat.attachment.tooLarge', { name }) };
        this.postState();
        continue;
      }
      await this.addDraft(name, mimeForFileName(name), body);
    }
  }

  private async pasteFile(
    incoming: Extract<ChatFromWebview, { type: 'pasteFile' }>,
  ): Promise<void> {
    const name = safeFileName(incoming.fileName);
    const body = Buffer.from(incoming.base64, 'base64');
    if (body.length > MAX_ATTACHMENT_BYTES) {
      this.notice = { kind: 'error', text: t('chat.attachment.tooLarge', { name }) };
      this.postState();
      return;
    }

    const mimeType =
      incoming.mimeType.trim() === '' ? mimeForFileName(name) : incoming.mimeType;
    await this.addDraft(name, mimeType, body);
  }

  private async addDraft(rawName: string, mimeType: string, body: Buffer): Promise<void> {
    if (this.target === undefined) {
      await this.pickTarget();
      if (this.target === undefined) {
        return;
      }
    }

    const target = this.target;
    if (target === undefined) {
      return;
    }

    this.attachmentCounter += 1;
    const draft: DraftAttachment = {
      id: `att-${this.attachmentCounter}`,
      fileName: safeFileName(rawName),
      mimeType,
      body,
      uploading: true,
      failed: false,
      terminalId: target.terminalId,
    };
    this.drafts.push(draft);
    this.postState();

    const client = await this.actionClient();
    if (client === undefined) {
      if (this.drafts.includes(draft)) {
        draft.uploading = false;
        draft.failed = true;
        this.notice = {
          kind: 'error',
          text: t('chat.attachment.failed', { name: draft.fileName }),
        };
      }
      this.postState();
      return;
    }

    try {
      const staged = await client.stageAttachment(
        target.terminalId,
        draft.fileName,
        body,
        mimeType,
      );
      if (!this.drafts.includes(draft) || this.target?.terminalId !== target.terminalId) {
        void client
          .discardAttachment(target.terminalId, staged.attachmentId)
          .catch(() => undefined);
        return;
      }
      draft.attachmentId = staged.attachmentId;
      draft.stagedAt = Date.now();
      draft.uploading = false;
      draft.failed = false;
    } catch {
      if (this.drafts.includes(draft) && this.target?.terminalId === target.terminalId) {
        draft.uploading = false;
        draft.failed = true;
        this.notice = {
          kind: 'error',
          text: t('chat.attachment.failed', { name: draft.fileName }),
        };
      }
    }
    this.postState();
  }

  private removeAttachment(id: string): void {
    const draft = this.drafts.find((item) => item.id === id);
    if (draft === undefined) {
      return;
    }
    this.drafts = this.drafts.filter((item) => item.id !== id);
    this.discardStaged(draft);
    this.postState();
  }

  private clearDrafts(): void {
    const drafts = this.drafts;
    this.drafts = [];
    for (const draft of drafts) {
      this.discardStaged(draft);
    }
  }

  private discardStaged(draft: DraftAttachment): void {
    const attachmentId = draft.attachmentId;
    if (attachmentId === undefined) {
      return;
    }
    void this.services.session
      .currentClient()
      .then((client) => client?.discardAttachment(draft.terminalId, attachmentId))
      .catch(() => undefined);
  }

  private async requestAttachment(id: string): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    const key = `${target.terminalId}:${id}`;
    const cached = this.attachmentCache.get(key);
    if (cached !== undefined) {
      this.post({ type: 'attachmentData', id, dataUri: cached });
      return;
    }
    if (this.attachmentRequests.has(key)) {
      return;
    }

    this.attachmentRequests.add(key);
    try {
      const client = await this.services.session.currentClient();
      if (client === undefined) {
        return;
      }
      const response = await client.downloadChatAttachment(target.terminalId, id);
      const contentType = response.contentType ?? 'image/png';
      if (!isImageMime(contentType) || response.body.length > MAX_ATTACHMENT_BYTES) {
        return;
      }
      const dataUri = `data:${contentType};base64,${response.body.toString('base64')}`;
      this.attachmentCache.set(key, dataUri);
      if (this.target?.terminalId === target.terminalId) {
        this.post({ type: 'attachmentData', id, dataUri });
      }
    } catch {
    } finally {
      this.attachmentRequests.delete(key);
    }
  }

  private async openAttachment(id: string): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    const client = await this.actionClient();
    if (client === undefined) {
      return;
    }

    const name = this.attachmentName(id) ?? id;
    const response = await client.downloadChatAttachment(target.terminalId, id);
    const directory = vscode.Uri.joinPath(
      this.services.context.globalStorageUri,
      'chat-attachments',
      safeFileName(id),
    );
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, safeFileName(name));
    await vscode.workspace.fs.writeFile(uri, response.body);
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  private attachmentName(id: string): string | undefined {
    const snapshot = this.stream?.current;
    if (snapshot === undefined) {
      return undefined;
    }
    for (const entry of snapshot.entries) {
      for (const segment of entry.segments) {
        if (segment.kind === 'attachment' && segment.attachment.id === id) {
          return segment.attachment.filename;
        }
      }
    }
    return undefined;
  }

  private async openFile(
    incoming: Extract<ChatFromWebview, { type: 'openFile' }>,
  ): Promise<void> {
    const original = incoming.path;
    const file = original.startsWith('./') ? original.slice(2) : original;
    let result = await resolveWorkspaceFile(file);

    if (result.kind === 'notFound' && !isAbsolute(file)) {
      const matches = await vscode.workspace.findFiles(`**/${file}`, '**/node_modules/**', 2);
      const match = matches[0];
      if (matches.length === 1 && match !== undefined) {
        result = { kind: 'found', uri: match };
      }
    }

    if (result.kind !== 'found') {
      this.notice = {
        kind: 'error',
        text: t('chat.notice.fileNotFound', { file: original }),
      };
      this.postState();
      return;
    }

    if (incoming.line === undefined) {
      await vscode.window.showTextDocument(result.uri, {
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });
      return;
    }

    const document = await vscode.workspace.openTextDocument(result.uri);
    const lastLine = Math.max(0, document.lineCount - 1);
    const start = Math.min(lastLine, Math.max(0, incoming.line - 1));
    const end = Math.min(lastLine, Math.max(start, (incoming.endLine ?? incoming.line) - 1));
    const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
    const editor = await vscode.window.showTextDocument(result.uri, {
      preserveFocus: false,
      selection: range,
      viewColumn: vscode.ViewColumn.One,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  private async queryMentions(query: string): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }

    const client = await this.services.session.currentClient();
    let mentions: ChatMention[] = [];
    let prompts: SavedPrompt[] = [];
    let files: TerminalFileEntry[] = [];

    if (client !== undefined) {
      try {
        mentions = await this.mentionsFor(client, target.terminalId);
      } catch {
        mentions = [];
      }

      try {
        prompts = await this.savedPromptsFor(client);
      } catch {
        prompts = [];
      }

      if (this.isOwner && query.trim() !== '') {
        try {
          const index = await client.listTerminalFiles(target.terminalId, {
            query,
            limit: 20,
          });
          files = index.entries;
        } catch {
          files = [];
        }
      }
    }

    if (this.target !== target) {
      return;
    }

    this.post({
      type: 'mentions',
      query,
      items: [
        ...catalogMentionViews(mentions, query),
        ...savedPromptViews(prompts, query, target.workspaceId),
        ...fileMentionViews(files),
      ],
    });
  }

  private async mentionsFor(
    client: WireClient,
    terminalId: string,
  ): Promise<ChatMention[]> {
    const cached = this.mentionCache.get(terminalId);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < MENTION_CACHE_MS) {
      return cached.mentions;
    }
    const mentions = await client.listMentions(terminalId);
    this.mentionCache.set(terminalId, { at: now, mentions });
    return mentions;
  }

  private async savedPromptsFor(client: WireClient): Promise<SavedPrompt[]> {
    const now = Date.now();
    if (this.promptCache !== undefined && now - this.promptCache.at < MENTION_CACHE_MS) {
      return this.promptCache.prompts;
    }
    const prompts = await client.listSavedPrompts();
    this.promptCache = { at: now, prompts };
    return prompts;
  }

  private addSelection(): void {
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (editor !== undefined && !editor.selection.isEmpty) {
      this.addReferences(collectReferences(editor));
    } else {
      this.notice = { kind: 'error', text: t('chat.notice.noSelection') };
    }
    this.postState();
  }

  private pasteText(incoming: Extract<ChatFromWebview, { type: 'pasteText' }>): void {
    const editors: vscode.TextEditor[] = [];
    for (const editor of [
      vscode.window.activeTextEditor,
      this.lastEditor,
      ...vscode.window.visibleTextEditors,
    ]) {
      if (editor !== undefined && !editors.includes(editor)) {
        editors.push(editor);
      }
    }

    for (const editor of editors) {
      const selections = editor.selections.map((selection) =>
        editor.document.getText(selection),
      );
      if (isCodeFromSelection(incoming.text, selections)) {
        this.addReferences(collectReferences(editor));
        this.postState();
        this.post({
          type: 'pastedAsReference',
          start: incoming.start,
          end: incoming.end,
          text: incoming.text,
        });
        return;
      }
    }
  }

  private async send(message: string): Promise<void> {
    this.message = message;

    const uploading = this.drafts.find((draft) => draft.uploading);
    if (uploading !== undefined) {
      this.notice = {
        kind: 'error',
        text: t('chat.attachment.uploading', { name: uploading.fileName }),
      };
      this.postState();
      return;
    }

    if (this.target === undefined) {
      await this.pickTarget();
      if (this.target === undefined) {
        return;
      }
    }

    const target = this.target;
    if (target === undefined) {
      return;
    }

    const text = formatPrompt(
      message,
      this.references.map((item) => item.reference),
      { heading: t('compose.prompt.heading') },
    );
    let attachments = this.drafts.filter(
      (draft) => !draft.failed && draft.attachmentId !== undefined,
    );
    if (text.trim() === '' && attachments.length === 0) {
      return;
    }

    const client = await this.actionClient();
    if (client === undefined) {
      return;
    }

    const now = Date.now();
    for (const draft of attachments) {
      if (!needsRestage(draft.stagedAt ?? 0, now)) {
        continue;
      }
      try {
        const staged = await client.stageAttachment(
          draft.terminalId,
          draft.fileName,
          draft.body,
          draft.mimeType,
        );
        draft.attachmentId = staged.attachmentId;
        draft.stagedAt = Date.now();
        draft.failed = false;
      } catch {
        draft.failed = true;
        draft.uploading = false;
        this.notice = {
          kind: 'error',
          text: t('chat.attachment.failed', { name: draft.fileName }),
        };
        this.postState();
        return;
      }
    }

    attachments = this.drafts.filter(
      (draft) => !draft.failed && draft.attachmentId !== undefined,
    );
    if (text.trim() === '' && attachments.length === 0) {
      return;
    }

    const segments: PromptSegment[] = [];
    if (text.trim() !== '') {
      segments.push({ text });
    }
    for (const draft of attachments) {
      if (draft.attachmentId !== undefined) {
        segments.push({ attachmentId: draft.attachmentId });
      }
    }

    const clientMessageId = randomUUID();
    const view: ChatEntryView = {
      id: `pending-${clientMessageId}`,
      role: 'user',
      kind: 'message',
      text,
      ts: new Date().toISOString(),
      attachments: attachments.flatMap((draft) =>
        draft.attachmentId === undefined
          ? []
          : [
              {
                id: draft.attachmentId,
                filename: draft.fileName,
                isImage: isImageMime(draft.mimeType),
              },
            ],
      ),
      pending: true,
    };
    this.pending.push({ clientMessageId, view });
    this.sending = true;
    this.notice = undefined;
    this.postState();

    try {
      await client.sendPromptSegments(target.terminalId, segments, clientMessageId);
    } catch (error) {
      this.pending = this.pending.filter((item) => item.clientMessageId !== clientMessageId);
      this.sending = false;
      this.notice = this.sendErrorNotice(error, target.terminalName);
      this.postState();
      return;
    }

    this.message = '';
    this.references = [];
    this.drafts = [];
    this.sending = false;
    await this.services.memory.remember(target);
    this.postState();
  }

  private async markRead(): Promise<void> {
    const snapshot = this.stream?.current;
    if (snapshot !== undefined) {
      await this.maybeMarkRead(snapshot);
    }
  }

  private async maybeMarkRead(snapshot: ChatSnapshot): Promise<void> {
    if (!this.isOwner || snapshot.unreadCount <= 0) {
      return;
    }
    const target = this.target;
    const client = this.streamClient;
    if (target === undefined || client === undefined) {
      return;
    }
    const now = Date.now();
    if (now - this.lastMarkReadAt < MARK_READ_INTERVAL_MS) {
      return;
    }
    this.lastMarkReadAt = now;
    try {
      await client.markChatRead(target.terminalId);
    } catch (error) {
      await this.handleError(error);
    }
  }

  private async actionClient(): Promise<WireClient | undefined> {
    const client = await this.services.session.ensureClient();
    this.paired = client !== undefined;
    return client;
  }

  private async refreshIdentity(): Promise<void> {
    const credentials = await this.services.session.credentials();
    this.paired = credentials !== undefined;
    this.isOwner = credentials === undefined || credentials.role !== 'guest';
  }

  private ensureStream(): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await this.performEnsureStream();
      } catch (error) {
        await this.handleError(error);
      }
    };
    this.ensureTask = this.ensureTask.then(run, run);
    return this.ensureTask;
  }

  private async performEnsureStream(): Promise<void> {
    if (!this.hasVisibleSurface()) {
      return;
    }

    const version = this.streamVersion;
    await this.refreshIdentity();
    if (version !== this.streamVersion || !this.hasVisibleSurface()) {
      return;
    }

    const target = this.target;
    if (target === undefined) {
      this.disposeStream();
      this.postState();
      return;
    }

    const client = await this.services.session.currentClient();
    if (version !== this.streamVersion || !this.hasVisibleSurface()) {
      return;
    }
    if (client === undefined) {
      this.paired = false;
      this.disposeStream();
      this.postState();
      return;
    }
    this.paired = true;

    if (
      this.stream !== undefined &&
      (this.streamClient !== client || this.streamTerminalId !== target.terminalId)
    ) {
      this.disposeStream();
    }

    if (this.stream === undefined) {
      const supported = await this.ensureCapability(client);
      if (version !== this.streamVersion || !this.hasVisibleSurface()) {
        return;
      }
      if (!supported) {
        this.postState();
        return;
      }
      this.startStream(client, target);
    } else {
      this.stream.start();
    }

    this.postState();
  }

  private async ensureCapability(client: WireClient): Promise<boolean> {
    if (this.capabilityClient === client) {
      if (this.capabilityMissing) {
        this.notice = { kind: 'error', text: t('chat.notice.unsupported') };
      }
      return !this.capabilityMissing;
    }

    this.capabilityClient = client;
    try {
      const info = await client.info();
      this.capabilityMissing = !info.capabilities.includes('terminalChat');
    } catch (error) {
      this.capabilityClient = undefined;
      this.capabilityMissing = false;
      await showFlowError(this.services.session, error);
      return false;
    }

    if (this.capabilityMissing) {
      this.notice = { kind: 'error', text: t('chat.notice.unsupported') };
    }
    return !this.capabilityMissing;
  }

  private startStream(client: WireClient, target: AgentTarget): void {
    const stream = new ChatStream({ client, terminalId: target.terminalId });
    this.stream = stream;
    this.streamClient = client;
    this.streamTerminalId = target.terminalId;
    this.streamUnsubscribers = [
      stream.onSnapshot((snapshot) => {
        this.handleSnapshot(snapshot);
      }),
      stream.onState(() => {
        this.postState();
      }),
    ];
    stream.start();
  }

  private handleSnapshot(snapshot: ChatSnapshot): void {
    const firstId = snapshot.entries[0]?.id;
    if (this.loadingOlder && firstId !== this.loadOlderFirstId) {
      this.loadingOlder = false;
      this.loadOlderFirstId = undefined;
      this.clearLoadingOlderTimer();
    }

    this.pending = unconfirmedPending(this.pending, snapshot);

    this.postState();
    void this.maybeMarkRead(snapshot);
  }

  private stopStreamIfIdle(): void {
    if (!this.hasVisibleSurface()) {
      this.stopStream();
    }
  }

  private stopStream(): void {
    this.streamVersion += 1;
    this.disposeStream();
  }

  private disposeStream(): void {
    for (const unsubscribe of this.streamUnsubscribers) {
      unsubscribe();
    }
    this.streamUnsubscribers = [];
    this.stream?.stop();
    this.stream = undefined;
    this.streamClient = undefined;
    this.streamTerminalId = undefined;
  }

  private async handleCredentialsChanged(): Promise<void> {
    this.capabilityClient = undefined;
    this.capabilityMissing = false;
    this.stopStream();
    await this.refreshIdentity();
    if (this.hasVisibleSurface()) {
      await this.ensureStream();
    } else {
      this.postState();
    }
  }

  private async handleError(error: unknown): Promise<void> {
    if (isWireError(error) && error.status === 403) {
      this.notice = { kind: 'error', text: t('chat.notice.ownerOnly') };
      this.postState();
      return;
    }
    if (isWireError(error) && error.messageId === 'chatBusy') {
      this.notice = { kind: 'error', text: t('chat.notice.chatBusy') };
      this.postState();
      return;
    }
    await showFlowError(this.services.session, error);
  }

  private sendErrorNotice(error: unknown, name: string): ChatNotice {
    if (isWireError(error) && error.status === 403) {
      return { kind: 'error', text: t('chat.notice.ownerOnly') };
    }
    if (isWireError(error) && error.messageId === 'chatBusy') {
      return { kind: 'error', text: t('chat.notice.chatBusy') };
    }
    return {
      kind: 'error',
      text: `${t('chat.notice.sendFailed', { name })} ${describeError(error)}`,
    };
  }

  private async confirm(message: string, button: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, button);
    return choice === button;
  }

  private hasVisibleSurface(): boolean {
    for (const surface of this.surfaces) {
      if (surface.visible) {
        return true;
      }
    }
    return false;
  }

  private addReferences(incoming: readonly CodeReference[]): void {
    const headers = new Set(
      this.references.map((item) => formatReferenceHeader(item.reference)),
    );
    for (const reference of incoming) {
      const header = formatReferenceHeader(reference);
      if (headers.has(header)) {
        continue;
      }
      headers.add(header);
      this.referenceCounter += 1;
      this.references.push({ id: `ref-${this.referenceCounter}`, reference });
    }
  }

  private threadColor(slot: number): string | undefined {
    return this.stream?.current?.threads?.items.find((item) => item.id === slot)?.color;
  }

  private pendingPrompt(): string | undefined {
    const target = this.target;
    if (target === undefined) {
      return undefined;
    }
    return this.monitor.snapshot?.pendingPrompts.find(
      (item) => item.terminalId === target.terminalId,
    )?.prompt;
  }

  private composerView(): ChatComposerView {
    return {
      message: this.message,
      references: this.references.map((item) => this.referenceView(item)),
      attachments: this.drafts.map((draft) => ({
        id: draft.id,
        fileName: draft.fileName,
        isImage: isImageMime(draft.mimeType),
        uploading: draft.uploading,
        failed: draft.failed,
      })),
      sending: this.sending,
    };
  }

  private referenceView(item: StoredReference): ChatReferenceView {
    const reference = item.reference;
    const view: ChatReferenceView = {
      id: item.id,
      header: formatReferenceHeader(reference),
      path: reference.path,
    };
    if (reference.startLine !== undefined) {
      view.startLine = reference.startLine;
    }
    if (reference.text !== undefined) {
      view.text = reference.text;
    }
    return view;
  }

  private buildState(): ChatViewState {
    return buildChatViewState({
      locale: currentLocale(),
      isMac: IS_MAC,
      isOwner: this.isOwner,
      connection: connectionFor(
        this.paired,
        this.target !== undefined,
        this.stream?.state ?? 'connecting',
      ),
      target: this.target,
      snapshot: this.stream?.current,
      pendingEntries: this.pending,
      pendingPrompt: this.pendingPrompt(),
      loadingOlder: this.loadingOlder,
      composer: this.composerView(),
      notice: this.notice,
    });
  }

  private postState(): void {
    if (!this.disposed) {
      this.post({ type: 'state', state: this.buildState() });
    }
  }

  private post(payload: ChatToWebview): void {
    for (const surface of this.surfaces) {
      void Promise.resolve(surface.webview.postMessage(payload)).catch(() => undefined);
    }
  }

  private clearLoadingOlderTimer(): void {
    if (this.loadingOlderTimer !== undefined) {
      clearTimeout(this.loadingOlderTimer);
      this.loadingOlderTimer = undefined;
    }
  }
}
