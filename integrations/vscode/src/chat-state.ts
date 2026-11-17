import type { ChatEntry, ChatSnapshot, ChatStreamState, ChatThreads } from '@maestri-bridge/core';
import type {
  ChatComposerView,
  ChatConnection,
  ChatEntryView,
  ChatNotice,
  ChatTargetView,
  ChatThreadsView,
  ChatViewState,
} from './chat-protocol.ts';
import type { LocaleId } from './i18n/index.ts';
import type { AgentTarget } from './target-memory.ts';

export interface PendingChatEntry {
  clientMessageId: string;
  view: ChatEntryView;
}

export interface ChatViewStateInput {
  locale: LocaleId;
  isMac: boolean;
  isOwner: boolean;
  connection: ChatConnection;
  target?: AgentTarget;
  snapshot?: ChatSnapshot;
  pendingEntries: readonly PendingChatEntry[];
  pendingPrompt?: string;
  loadingOlder: boolean;
  composer: ChatComposerView;
  notice?: ChatNotice;
}

export function connectionFor(
  paired: boolean,
  hasTarget: boolean,
  streamState: ChatStreamState,
): ChatConnection {
  if (!paired) {
    return 'unpaired';
  }
  if (!hasTarget) {
    return 'noTarget';
  }
  return streamState;
}

const ECHO_TOLERANCE_MS = 60000;

export function unconfirmedPending(
  pending: readonly PendingChatEntry[],
  snapshot: ChatSnapshot | undefined,
): PendingChatEntry[] {
  if (snapshot === undefined) {
    return [...pending];
  }
  return pending.filter((item) => !isEchoed(item, snapshot.entries));
}

function isEchoed(pending: PendingChatEntry, entries: readonly ChatEntry[]): boolean {
  const sentAt = Date.parse(pending.view.ts);
  return entries.some((entry) => {
    if (entry.clientMessageId !== undefined) {
      return entry.clientMessageId.toLowerCase() === pending.clientMessageId.toLowerCase();
    }
    return (
      entry.role === 'user' &&
      entry.text.trim() === pending.view.text.trim() &&
      Date.parse(entry.ts) >= sentAt - ECHO_TOLERANCE_MS
    );
  });
}

export function buildChatViewState(input: ChatViewStateInput): ChatViewState {
  const snapshot = input.snapshot;
  const entries = snapshot === undefined ? [] : snapshot.entries.map(entryView);
  for (const pending of unconfirmedPending(input.pendingEntries, snapshot)) {
    entries.push(pending.view);
  }

  const state: ChatViewState = {
    locale: input.locale,
    isMac: input.isMac,
    isOwner: input.isOwner,
    connection: input.connection,
    chatEnabled: snapshot?.enabled ?? true,
    turnInterrupted: snapshot?.turnInterrupted ?? false,
    entries,
    hasOlder: snapshot?.hasOlderOnRecord ?? false,
    loadingOlder: input.loadingOlder,
    canClear: snapshot?.canClear ?? false,
    composer: input.composer,
  };

  if (input.target !== undefined) {
    state.target = targetView(input.target);
  }
  if (snapshot?.status !== undefined) {
    state.status = snapshot.status;
  }
  if (snapshot?.talkingToAgentName !== undefined) {
    state.talkingToAgentName = snapshot.talkingToAgentName;
  }
  if (snapshot?.answeringAgentName !== undefined) {
    state.answeringAgentName = snapshot.answeringAgentName;
  }
  if (input.pendingPrompt !== undefined) {
    state.pendingPrompt = input.pendingPrompt;
  }
  if (snapshot?.threads !== undefined) {
    state.threads = threadsView(snapshot.threads);
  }
  if (input.notice !== undefined) {
    state.notice = input.notice;
  }

  return state;
}

function entryView(entry: ChatEntry): ChatEntryView {
  const view: ChatEntryView = {
    id: entry.id,
    role: entry.role,
    kind: entry.kind,
    text: entry.text,
    ts: entry.ts,
    attachments: entry.segments.flatMap((segment) =>
      segment.kind === 'attachment'
        ? [
            {
              id: segment.attachment.id,
              filename: segment.attachment.filename,
              isImage: segment.attachment.isImage,
            },
          ]
        : [],
    ),
  };
  if (entry.authorName !== undefined) {
    view.authorName = entry.authorName;
  }
  return view;
}

function threadsView(threads: ChatThreads): ChatThreadsView {
  return {
    canSelect: threads.canSelect,
    items: threads.items.map((item) => ({
      slot: item.id,
      color: item.color,
      hasMessages: item.hasMessages,
      active: item.id === threads.activeSlot,
    })),
  };
}

function targetView(target: AgentTarget): ChatTargetView {
  const view: ChatTargetView = {
    terminalName: target.terminalName,
    workspaceName: target.workspaceName,
  };
  if (target.floorName !== undefined) {
    view.floorText = target.floorName;
  }
  return view;
}
