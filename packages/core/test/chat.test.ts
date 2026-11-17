import { describe, expect, it } from 'vitest';
import { WireError } from '../src/errors.ts';
import {
  parseChatEntry,
  parseChatHistory,
  parseChatSnapshot,
  parseChatThreadPreviews,
  parseMentions,
  parseStagedAttachment,
  parseTerminalFileIndex,
} from '../src/chat.ts';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    role: 'user',
    ts: '2026-01-01T00:00:00Z',
    kind: 'message',
    text: 'oi',
    ...overrides,
  };
}

function captureWireError(run: () => unknown): WireError {
  try {
    run();
  } catch (error) {
    if (error instanceof WireError) {
      return error;
    }
    throw error;
  }
  throw new Error('Esperava um WireError.');
}

describe('parseChatEntry', () => {
  it('lê autor no topo, texto e os dois formatos de segmento', () => {
    const parsed = parseChatEntry({
      id: 'e1',
      role: 'user',
      ts: '2026-01-02T03:04:05Z',
      kind: 'message',
      text: 'Olá',
      authorName: 'Nina',
      agentType: 'claude_code',
      clientMessageId: 'client-1',
      segments: [
        { text: 'Olá' },
        { type: 'text', text: 'mundo' },
        {
          attachment: {
            id: 'a1',
            isImage: true,
            filename: 'foto.png',
            contentType: 'image/png',
          },
        },
        { type: 'attachment', id: 'a2', isImage: false, filename: 'nota.txt' },
        { type: 'image', url: 'https://example.com/x.png' },
        'lixo',
      ],
    });

    expect(parsed).toEqual({
      id: 'e1',
      role: 'user',
      ts: '2026-01-02T03:04:05Z',
      kind: 'message',
      text: 'Olá',
      authorName: 'Nina',
      agentType: 'claude_code',
      clientMessageId: 'client-1',
      segments: [
        { kind: 'text', text: 'Olá' },
        { kind: 'text', text: 'mundo' },
        {
          kind: 'attachment',
          attachment: {
            id: 'a1',
            isImage: true,
            filename: 'foto.png',
            contentType: 'image/png',
          },
        },
        {
          kind: 'attachment',
          attachment: { id: 'a2', isImage: false, filename: 'nota.txt' },
        },
      ],
    });
  });

  it('usa author.name e author.agentType quando não há campos no topo', () => {
    const parsed = parseChatEntry(
      entry({
        role: 'agent',
        kind: 'final',
        author: { name: 'Head', agentType: 'open_code' },
      }),
    );

    expect(parsed?.authorName).toBe('Head');
    expect(parsed?.agentType).toBe('open_code');
  });

  it('devolve text vazio e segments vazio quando ausentes', () => {
    const parsed = parseChatEntry({
      id: 'e1',
      role: 'agent',
      ts: '2026-01-01T00:00:00Z',
      kind: 'progress',
    });

    expect(parsed).toEqual({
      id: 'e1',
      role: 'agent',
      ts: '2026-01-01T00:00:00Z',
      kind: 'progress',
      text: '',
      segments: [],
    });
  });

  it('converte ts numérico em milissegundos, segundos e época Swift', () => {
    const milliseconds = parseChatEntry(
      entry({ ts: 1700000000000 }),
    );
    expect(milliseconds?.ts).toBe('2023-11-14T22:13:20.000Z');

    const seconds = parseChatEntry(entry({ ts: 1700000000 }));
    expect(seconds?.ts).toBe('2023-11-14T22:13:20.000Z');

    const swift = parseChatEntry(entry({ ts: 0 }));
    expect(swift?.ts).toBe('2001-01-01T00:00:00.000Z');
  });

  it('gera id para divider sem id', () => {
    const parsed = parseChatEntry(
      entry({ id: undefined, kind: 'divider', ts: '2026-01-01T00:00:00Z' }),
    );

    expect(parsed?.id).toBe('divider-2026-01-01T00:00:00Z');
  });

  it('descarta entradas sem id, sem ts, com kind ou role desconhecidos', () => {
    expect(parseChatEntry(entry({ id: undefined }))).toBeUndefined();
    expect(parseChatEntry(entry({ ts: undefined }))).toBeUndefined();
    expect(parseChatEntry(entry({ kind: 'futureKind' }))).toBeUndefined();
    expect(parseChatEntry(entry({ role: 'system' }))).toBeUndefined();
    expect(parseChatEntry('lixo')).toBeUndefined();
  });
});

describe('parseChatSnapshot', () => {
  it('lê o snapshot completo e descarta entradas inválidas', () => {
    const snapshot = parseChatSnapshot({
      terminalId: 't1',
      conversationId: 'c1',
      enabled: true,
      status: 'working',
      unreadCount: 3,
      canClear: true,
      talkingToAgentName: 'Nina',
      answeringAgentName: 'Head',
      turnInterrupted: true,
      hasOlderOnRecord: false,
      entries: [
        entry(),
        entry({ id: 'e2', kind: 'unknown' }),
        entry({ id: 'e3', ts: undefined }),
        'lixo',
      ],
      threads: {
        activeSlot: 1,
        canSelect: true,
        items: [
          { id: 0, color: 'blue', hasMessages: true },
          { id: 2 },
          { id: 7, color: 'red' },
        ],
      },
    });

    expect(snapshot.terminalId).toBe('t1');
    expect(snapshot.conversationId).toBe('c1');
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.status).toBe('working');
    expect(snapshot.unreadCount).toBe(3);
    expect(snapshot.canClear).toBe(true);
    expect(snapshot.talkingToAgentName).toBe('Nina');
    expect(snapshot.answeringAgentName).toBe('Head');
    expect(snapshot.turnInterrupted).toBe(true);
    expect(snapshot.hasOlderOnRecord).toBe(false);
    expect(snapshot.entries.map((item) => item.id)).toEqual(['e1']);
    expect(snapshot.threads).toEqual({
      activeSlot: 1,
      canSelect: true,
      items: [{ id: 0, color: 'blue', hasMessages: true }],
    });
  });

  it('aplica defaults e mantém status desconhecido', () => {
    const minimal = parseChatSnapshot({
      terminalId: 't1',
      conversationId: 'c1',
      entries: [],
      status: 'paused',
    });

    expect(minimal).toEqual({
      terminalId: 't1',
      conversationId: 'c1',
      enabled: false,
      status: 'paused',
      entries: [],
      unreadCount: 0,
      canClear: false,
    });

    const withoutStatus = parseChatSnapshot({
      terminalId: 't1',
      conversationId: 'c1',
      entries: [],
    });
    expect(withoutStatus.status).toBe('idle');
  });

  it('exige terminalId, conversationId e entries', () => {
    for (const raw of [
      {},
      { conversationId: 'c1', entries: [] },
      { terminalId: 't1', entries: [] },
      { terminalId: 't1', conversationId: 'c1', entries: 'nada' },
    ]) {
      const error = captureWireError(() => parseChatSnapshot(raw));
      expect(error.messageId).toBe('invalidResponse');
    }
  });
});

describe('parseChatThreadPreviews', () => {
  it('lê threads e ignora itens inválidos', () => {
    const previews = parseChatThreadPreviews({
      threads: [
        { id: 0, conversationId: 'c1', entries: [entry()] },
        { id: 1, conversationId: 'c2' },
        { id: 2 },
        'lixo',
      ],
    });

    expect(previews).toHaveLength(2);
    expect(previews[0]?.entries.map((item) => item.id)).toEqual(['e1']);
    expect(previews[1]).toEqual({ id: 1, conversationId: 'c2', entries: [] });
  });

  it('exige o corpo com threads', () => {
    const error = captureWireError(() => parseChatThreadPreviews({}));
    expect(error.messageId).toBe('invalidResponse');
  });
});

describe('parseChatHistory', () => {
  it('lê histórico e descarta entradas inválidas', () => {
    const history = parseChatHistory({
      conversationId: 'c1',
      entries: [entry(), entry({ id: 'e2', role: 'system' })],
    });

    expect(history).toEqual({
      conversationId: 'c1',
      entries: [
        expect.objectContaining({ id: 'e1' }),
      ],
    });
  });

  it('exige conversationId e entries', () => {
    for (const raw of [{}, { conversationId: 'c1' }, { entries: [] }]) {
      const error = captureWireError(() => parseChatHistory(raw));
      expect(error.messageId).toBe('invalidResponse');
    }
  });
});

describe('parseStagedAttachment', () => {
  it('lê o anexo e o expiresAt opcional', () => {
    expect(
      parseStagedAttachment({
        attachmentId: 'a1',
        fileName: 'foto.png',
        mimeType: 'image/png',
        expiresAt: '2026-01-01T00:00:00Z',
      }),
    ).toEqual({
      attachmentId: 'a1',
      fileName: 'foto.png',
      mimeType: 'image/png',
      expiresAt: '2026-01-01T00:00:00Z',
    });

    expect(
      parseStagedAttachment({ attachmentId: 'a1', fileName: 'foto.png', mimeType: 'image/png' }),
    ).toEqual({ attachmentId: 'a1', fileName: 'foto.png', mimeType: 'image/png' });
  });

  it('exige os campos obrigatórios', () => {
    const error = captureWireError(() => parseStagedAttachment({ attachmentId: 'a1' }));
    expect(error.messageId).toBe('invalidResponse');
  });
});

describe('parseMentions', () => {
  it('lê menções e aplica defaults', () => {
    const mentions = parseMentions({
      mentions: [
        {
          kind: 'agent',
          id: 'a1',
          name: 'Nina',
          tokenName: 'nina',
          floorName: 'Ground',
          isOnActiveFloor: true,
          section: 'Agents',
          sectionOrder: 2,
          order: 3,
          depth: 1,
        },
        { kind: 'file', id: 'f1', name: 'a.ts' },
        { kind: 'agent', id: 'a2' },
        'lixo',
      ],
    });

    expect(mentions).toEqual([
      {
        kind: 'agent',
        id: 'a1',
        name: 'Nina',
        tokenName: 'nina',
        floorName: 'Ground',
        isOnActiveFloor: true,
        section: 'Agents',
        sectionOrder: 2,
        order: 3,
        depth: 1,
      },
      {
        kind: 'file',
        id: 'f1',
        name: 'a.ts',
        isOnActiveFloor: false,
        sectionOrder: 0,
        order: 0,
        depth: 0,
      },
    ]);
  });

  it('exige o corpo com mentions', () => {
    const error = captureWireError(() => parseMentions({}));
    expect(error.messageId).toBe('invalidResponse');
  });
});

describe('parseTerminalFileIndex', () => {
  it('lê arquivos e aplica defaults', () => {
    const index = parseTerminalFileIndex({
      query: 'app',
      root: '/projeto',
      isTruncated: true,
      entries: [
        { relativePath: 'src/app.ts', name: 'app.ts' },
        { relativePath: 'src/lib', name: 'lib', isDirectory: true },
        { relativePath: 'x' },
        'lixo',
      ],
    });

    expect(index).toEqual({
      query: 'app',
      root: '/projeto',
      isTruncated: true,
      entries: [
        { relativePath: 'src/app.ts', name: 'app.ts', isDirectory: false },
        { relativePath: 'src/lib', name: 'lib', isDirectory: true },
      ],
    });

    expect(
      parseTerminalFileIndex({ entries: [] }),
    ).toEqual({ query: '', root: '', entries: [], isTruncated: false });
  });

  it('exige entries', () => {
    const error = captureWireError(() => parseTerminalFileIndex({}));
    expect(error.messageId).toBe('invalidResponse');
  });
});
