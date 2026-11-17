import { describe, expect, it } from 'vitest';
import type { ChatEntry, ChatSnapshot, ChatThreads } from '@maestri-bridge/core';
import { buildChatViewState, connectionFor } from '../src/chat-state.ts';
import type { ChatViewStateInput } from '../src/chat-state.ts';
import type { ChatComposerView, ChatEntryView } from '../src/chat-protocol.ts';
import type { AgentTarget } from '../src/target-memory.ts';

function snapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    terminalId: 't1',
    conversationId: 'c1',
    enabled: true,
    status: 'idle',
    entries: [],
    unreadCount: 0,
    canClear: false,
    ...overrides,
  };
}

function entry(overrides: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: 'e1',
    role: 'user',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'message',
    text: 'Oi',
    segments: [],
    ...overrides,
  };
}

function composer(overrides: Partial<ChatComposerView> = {}): ChatComposerView {
  return { message: '', references: [], attachments: [], sending: false, ...overrides };
}

function input(overrides: Partial<ChatViewStateInput> = {}): ChatViewStateInput {
  return {
    locale: 'pt-br',
    isMac: true,
    isOwner: true,
    connection: 'live',
    pendingEntries: [],
    loadingOlder: false,
    composer: composer(),
    ...overrides,
  };
}

describe('connectionFor', () => {
  it('trata sem credenciais como unpaired', () => {
    expect(connectionFor(false, true, 'live')).toBe('unpaired');
    expect(connectionFor(false, false, 'offline')).toBe('unpaired');
  });

  it('trata sem alvo como noTarget', () => {
    expect(connectionFor(true, false, 'live')).toBe('noTarget');
  });

  it('usa o estado do stream com credenciais e alvo', () => {
    expect(connectionFor(true, true, 'live')).toBe('live');
    expect(connectionFor(true, true, 'polling')).toBe('polling');
    expect(connectionFor(true, true, 'offline')).toBe('offline');
  });
});

describe('buildChatViewState', () => {
  it('reconhece o eco do host mesmo com o clientMessageId em maiúsculas', () => {
    const pendingView: ChatEntryView = {
      id: 'pending-abc',
      role: 'user',
      kind: 'message',
      text: 'Oi',
      ts: '2026-01-01T00:00:00.000Z',
      attachments: [],
      pending: true,
    };
    const state = buildChatViewState(
      input({
        pendingEntries: [{ clientMessageId: '8f14e45f-ceea-4e8a-9d2b-0c1f3a6b7d21', view: pendingView }],
        snapshot: snapshot({
          entries: [entry({ id: 'e5', clientMessageId: '8F14E45F-CEEA-4E8A-9D2B-0C1F3A6B7D21' })],
        }),
      }),
    );
    expect(state.entries.map((item) => item.id)).toEqual(['e5']);
  });

  it('esconde a mensagem pendente quando o host a registra sem clientMessageId', () => {
    const pendingView: ChatEntryView = {
      id: 'pending-m2',
      role: 'user',
      kind: 'message',
      text: 'Revise o login',
      ts: '2026-01-01T00:00:05.000Z',
      attachments: [],
      pending: true,
    };
    const pendingEntries = [{ clientMessageId: 'm2', view: pendingView }];

    const echoed = buildChatViewState(
      input({
        pendingEntries,
        snapshot: snapshot({ entries: [entry({ id: 'e9', text: 'Revise o login', ts: '2026-01-01T00:00:06.000Z' })] }),
      }),
    );
    expect(echoed.entries.map((item) => item.id)).toEqual(['e9']);

    const older = buildChatViewState(
      input({
        pendingEntries,
        snapshot: snapshot({ entries: [entry({ id: 'e1', text: 'Revise o login', ts: '2025-12-31T00:00:00.000Z' })] }),
      }),
    );
    expect(older.entries.map((item) => item.id)).toEqual(['e1', 'pending-m2']);
  });

  it('mostra a mensagem pendente até o snapshot trazer o mesmo clientMessageId', () => {
    const pendingView: ChatEntryView = {
      id: 'pending-m1',
      role: 'user',
      kind: 'message',
      text: 'Mensagem pendente',
      ts: '2026-01-01T00:00:00.000Z',
      attachments: [],
      pending: true,
    };
    const pendingEntries = [{ clientMessageId: 'm1', view: pendingView }];

    const withoutEcho = buildChatViewState(input({ pendingEntries, snapshot: snapshot() }));
    expect(withoutEcho.entries).toEqual([pendingView]);

    const withEcho = buildChatViewState(
      input({
        pendingEntries,
        snapshot: snapshot({ entries: [entry({ id: 'e1', clientMessageId: 'm1' })] }),
      }),
    );
    expect(withEcho.entries.map((item) => item.id)).toEqual(['e1']);
  });

  it('marca a thread ativa', () => {
    const threads: ChatThreads = {
      activeSlot: 1,
      canSelect: true,
      items: [
        { id: 0, color: 'blue', hasMessages: true },
        { id: 1, color: 'red', hasMessages: false },
      ],
    };

    const state = buildChatViewState(input({ snapshot: snapshot({ threads }) }));

    expect(state.threads).toEqual({
      canSelect: true,
      items: [
        { slot: 0, color: 'blue', hasMessages: true, active: false },
        { slot: 1, color: 'red', hasMessages: false, active: true },
      ],
    });
  });

  it('não inventa threads quando o snapshot não traz', () => {
    expect(buildChatViewState(input()).threads).toBeUndefined();
    expect(buildChatViewState(input({ snapshot: snapshot() })).threads).toBeUndefined();
  });

  it('trata o chat como ligado quando ainda não há snapshot', () => {
    const state = buildChatViewState(input());

    expect(state.chatEnabled).toBe(true);
    expect(state.entries).toEqual([]);
    expect(state.hasOlder).toBe(false);
    expect(state.canClear).toBe(false);
    expect(state.turnInterrupted).toBe(false);
  });

  it('mapeia anexos dos segmentos da entrada', () => {
    const state = buildChatViewState(
      input({
        snapshot: snapshot({
          entries: [
            entry({
              segments: [
                { kind: 'text', text: 'Veja' },
                {
                  kind: 'attachment',
                  attachment: {
                    id: 'a1',
                    filename: 'foto.png',
                    isImage: true,
                    contentType: 'image/png',
                  },
                },
              ],
            }),
          ],
        }),
      }),
    );

    expect(state.entries[0]?.attachments).toEqual([
      { id: 'a1', filename: 'foto.png', isImage: true },
    ]);
  });

  it('monta o alvo com o andar e repassa pendências e aviso', () => {
    const target: AgentTarget = {
      workspaceId: 'w1',
      workspaceName: 'Projeto',
      floorId: 'f2',
      floorName: 'Andar 2',
      terminalId: 't1',
      terminalName: 'Nina',
    };

    const state = buildChatViewState(
      input({
        target,
        pendingPrompt: 'Aprovar?',
        notice: { kind: 'info', text: 'Oi' },
        loadingOlder: true,
      }),
    );

    expect(state.target).toEqual({
      terminalName: 'Nina',
      workspaceName: 'Projeto',
      floorText: 'Andar 2',
    });
    expect(state.pendingPrompt).toBe('Aprovar?');
    expect(state.notice).toEqual({ kind: 'info', text: 'Oi' });
    expect(state.loadingOlder).toBe(true);
  });

  it('omite o andar quando o alvo não tem nome de andar', () => {
    const state = buildChatViewState(
      input({
        target: {
          workspaceId: 'w1',
          workspaceName: 'Projeto',
          terminalId: 't1',
          terminalName: 'Nina',
        },
      }),
    );

    expect(state.target).toEqual({ terminalName: 'Nina', workspaceName: 'Projeto' });
  });

  it('repassa status e nomes do snapshot', () => {
    const state = buildChatViewState(
      input({
        snapshot: snapshot({
          status: 'working',
          talkingToAgentName: 'Ana',
          answeringAgentName: 'Bia',
          turnInterrupted: true,
          hasOlderOnRecord: true,
          canClear: true,
        }),
      }),
    );

    expect(state.status).toBe('working');
    expect(state.talkingToAgentName).toBe('Ana');
    expect(state.answeringAgentName).toBe('Bia');
    expect(state.turnInterrupted).toBe(true);
    expect(state.hasOlder).toBe(true);
    expect(state.canClear).toBe(true);
  });
});
