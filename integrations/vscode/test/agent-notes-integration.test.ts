import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const threads: Array<{
    uri: { fsPath: string };
    range: unknown;
    comments: unknown[];
    label: string;
    collapsibleState: number;
    dispose(): void;
  }> = [];
  const reveals: Array<{ uri: string; preserveFocus?: boolean }> = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const messages: string[] = [];
  const docs = new Map<string, { getText: (range: { start: number; end: number }) => string }>();
  let handler: ((uri: unknown) => Promise<void>) | undefined;
  let pick: unknown;

  class Range {
    constructor(
      readonly start: number,
      readonly startChar: number,
      readonly end: number,
      readonly endChar: number,
    ) {}
  }
  class MarkdownString {
    constructor(readonly value: string) {}
  }
  class Disposable {
    constructor(private readonly fn?: () => void) {}
    dispose(): void { this.fn?.(); }
  }
  const controller = {
    options: {},
    createCommentThread(uri: never, range: never, comments: unknown[]) {
      const thread = {
        uri, range, comments, label: '', collapsibleState: 0,
        dispose() {},
      };
      threads.push(thread as never);
      return thread;
    },
    dispose() {},
  };

  return {
    store, threads, reveals, commands, messages, docs, Range, MarkdownString, Disposable, controller,
    getHandler: () => handler,
    setHandler: (value: (uri: unknown) => Promise<void>) => { handler = value; },
    getPick: () => pick,
    setPick: (value: unknown) => { pick = value; },
  };
});

vi.mock('vscode', () => ({
  Range: h.Range,
  MarkdownString: h.MarkdownString,
  Disposable: h.Disposable,
  CommentMode: { Preview: 1 },
  CommentThreadCollapsibleState: { Expanded: 2 },
  TextEditorRevealType: { InCenter: 0 },
  ViewColumn: { One: 1 },
  comments: { createCommentController: () => h.controller },
  commands: {
    registerCommand: (name: string, fn: (...args: unknown[]) => unknown) => {
      h.commands.set(name, fn);
      return new h.Disposable();
    },
  },
  window: {
    registerUriHandler: (value: { handleUri: (uri: unknown) => Promise<void> }) => {
      h.setHandler(value.handleUri);
      return new h.Disposable();
    },
    showWarningMessage: (message: string) => { h.messages.push(message); },
    showInformationMessage: (message: string) => { h.messages.push(message); },
    showTextDocument: async (uri: { fsPath: string }, options: { preserveFocus?: boolean }) => {
      h.reveals.push({ uri: uri.fsPath, preserveFocus: options.preserveFocus });
      return { revealRange() {} };
    },
    setStatusBarMessage() {},
    showQuickPick: async () => h.getPick(),
  },
  workspace: {
    getConfiguration: () => ({ get: () => true }),
    openTextDocument: async (uri: { fsPath: string }) => h.docs.get(uri.fsPath),
    getWorkspaceFolder: () => ({}),
    asRelativePath: (uri: { fsPath: string }) => uri.fsPath,
  },
}));

vi.mock('@maestri-bridge/core', () => ({
  SHOW_LINK_PATH: '/show',
  locateTerminal: () => undefined,
  parseShowLink: (query: string) => {
    const params = new URLSearchParams(query);
    const lines = params.get('lines');
    const [startLine, endLine] = lines?.split('-').map(Number) ?? [];
    return {
      ok: true,
      request: {
        file: params.get('file') ?? '',
        startLine,
        endLine,
        text: params.get('text') ?? undefined,
        from: params.get('from') ?? undefined,
        agentId: params.get('agent') ?? undefined,
        newTour: params.get('new') === '1',
      },
    };
  },
}));

vi.mock('../src/workspace-files.ts', () => ({
  resolveWorkspaceFile: async (file: string) => ({ kind: 'found', uri: { fsPath: file } }),
}));

import { registerAgentNotes } from '../src/agent-notes.ts';

const KEY = 'maestriBridge.lastNoteTour';
const FILE = '/workspace/pasta_teste/ação.ts';

function makeDoc(lines: string[]) {
  const uri = { fsPath: FILE };
  return {
    uri,
    lineCount: lines.length,
    lineAt: (index: number) => ({ text: lines[index] }),
    getText: (range: { start: number; end: number }) => lines.slice(range.start, range.end + 1).join('\n'),
  };
}

function anchor(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function showUri(text: string, lines = '2-3', newTour = false) {
  const query = new URLSearchParams({
    file: FILE,
    lines,
    text,
    agent: 'agent-1',
    from: 'Maia',
  });
  if (newTour) { query.set('new', '1'); }
  return { path: '/show', query: query.toString() };
}

function setup(saved?: unknown) {
  h.store.clear();
  h.threads.length = 0;
  h.reveals.length = 0;
  h.commands.clear();
  h.messages.length = 0;
  if (saved !== undefined) {
    h.store.set(KEY, saved);
  }
  const services = {
    context: {
      workspaceState: {
        get: (key: string) => h.store.get(key),
        update: async (key: string, value: unknown) => { h.store.set(key, value); },
      },
    },
    session: {},
  };
  const monitor = { snapshot: undefined };
  return registerAgentNotes(services as never, monitor as never);
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function newNote(text: string, lines?: string, newTour = false): Promise<void> {
  await h.getHandler()!(showUri(text, lines, newTour));
}

describe('registerAgentNotes — regressões comportamentais', () => {
  beforeEach(() => { h.docs.clear(); });

  it('nota nova apos reload, antes do Resume, preserva notas/checkpoint/progresso', async () => {
    const lines = ['inicio', 'const a = 1;', 'const b = 2;', 'const c = 3;', 'fim'];
    h.docs.set(FILE, makeDoc(lines) as never);
    const oldAnchor = anchor('const a = 1;\nconst b = 2;');
    const saved = {
      version: 1,
      agentKey: 'agent-1',
      currentIndex: 1,
      stops: [
        { file: FILE, startLine: 2, endLine: 3, anchor: oldAnchor, name: 'Maia', viewed: true, comments: [{ author: 'Maia', text: 'antiga 1', isReply: false }] },
        { file: FILE, startLine: 4, endLine: 4, anchor: anchor('const c = 3;'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'antiga 2', isReply: false }] },
      ],
    };
    const registration = setup(saved);
    await flush();
    expect(h.reveals).toHaveLength(0); // ativacao passiva: nada revelado

    await newNote('nota & Nova', '5-5');
    const result = h.store.get(KEY) as { stops: Array<{ comments: Array<{ text: string }> }>; currentIndex: number };
    expect(result.stops).toHaveLength(3);
    expect(result.stops[0]!.comments[0]!.text).toBe('antiga 1');
    expect(result.stops[1]!.comments[0]!.text).toBe('antiga 2');
    expect(result.stops[2]!.comments[0]!.text).toBe('nota & Nova');
    expect(result.currentIndex).toBe(1);
    registration.dispose();
  });

  it('nota do meio ausente volta ao slot original com ordem e progresso', async () => {
    const divergente = ['inicio', 'A', 'codigo diferente', 'C', 'fim'];
    h.docs.set(FILE, makeDoc(divergente) as never);
    const saved = {
      version: 1,
      agentKey: 'agent-1',
      currentIndex: 2,
      stops: [
        { file: FILE, startLine: 2, endLine: 2, anchor: anchor('A'), name: 'Maia', viewed: true, comments: [{ author: 'Maia', text: 'A', isReply: false }] },
        { file: FILE, startLine: 3, endLine: 3, anchor: anchor('B'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'B', isReply: false }] },
        { file: FILE, startLine: 4, endLine: 4, anchor: anchor('C'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'C', isReply: false }] },
      ],
    };
    const registration = setup(saved);
    await flush();
    expect(h.threads).toHaveLength(2);

    const before = h.store.get(KEY) as { currentIndex: number; stops: Array<{ comments: Array<{ text: string }> }> };
    expect(before.stops.map((note) => note.comments[0]!.text)).toEqual(['A', 'B', 'C']);
    expect(before.currentIndex).toBe(2);

    // O arquivo volta na mesma sessao; a navegacao reavalia o slot ausente.
    h.docs.set(FILE, makeDoc(['inicio', 'A', 'B', 'C', 'fim']) as never);
    await (h.commands.get('maestriBridge.notes.resume') as () => Promise<void>)();
    const after = h.store.get(KEY) as { currentIndex: number; stops: Array<{ startLine: number; comments: Array<{ text: string }> }> };
    expect(after.stops.map((note) => note.comments[0]!.text)).toEqual(['A', 'B', 'C']);
    expect(after.stops.map((note) => note.startLine)).toEqual([2, 3, 4]);
    expect(after.currentIndex).toBe(2);
    expect(h.threads).toHaveLength(3);
    registration.dispose();
  });

  it('dois slots ausentes: o segundo volta primeiro e entra antes na ordem ativa', async () => {
    h.docs.set(FILE, makeDoc(['x', ' divergent', ' divergente', 'C', 'fim']) as never);
    const saved = {
      version: 1, agentKey: 'agent-1', currentIndex: 1,
      stops: [
        { file: FILE, startLine: 2, endLine: 2, anchor: anchor('A'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'A', isReply: false }] },
        { file: FILE, startLine: 3, endLine: 3, anchor: anchor('B'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'B', isReply: false }] },
      ],
    };
    const registration = setup(saved);
    await flush();
    expect(h.threads).toHaveLength(0);
    expect(h.reveals).toHaveLength(0);

    h.docs.set(FILE, makeDoc(['x', ' diverges', 'B', 'C', 'fim']) as never);
    await (h.commands.get('maestriBridge.notes.resume') as () => Promise<void>)();
    const after = h.store.get(KEY) as { stops: Array<{ comments: Array<{ text: string }> }>; currentIndex: number };
    expect(after.stops.map((note) => note.comments[0]!.text)).toEqual(['A', 'B']);
    expect(after.currentIndex).toBe(1);
    expect(h.threads).toHaveLength(1);
    registration.dispose();
  });

  it('todas as notas ausentes: nota nova preserva slots e checkpoint', async () => {
    h.docs.set(FILE, makeDoc(['x', ' divergente', ' diverge', 'C', 'fim']) as never);
    const saved = {
      version: 1, agentKey: 'agent-1', currentIndex: 1,
      stops: [
        { file: FILE, startLine: 2, endLine: 2, anchor: anchor('A'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'A', isReply: false }] },
        { file: FILE, startLine: 3, endLine: 3, anchor: anchor('B'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'B', isReply: false }] },
      ],
    };
    const registration = setup(saved);
    await flush();
    expect(h.threads).toHaveLength(0);
    await newNote('nova', '4-4');
    const after = h.store.get(KEY) as { stops: Array<{ comments: Array<{ text: string }> }>; currentIndex: number };
    expect(after.stops.map((note) => note.comments[0]!.text)).toEqual(['A', 'B', 'nova']);
    expect(after.currentIndex).toBe(1);
    registration.dispose();
  });

  it('fechar a ultima nota apaga o snapshot e o reload fica vazio', async () => {
    h.docs.set(FILE, makeDoc(['inicio', 'A', 'fim']) as never);
    const saved = {
      version: 1, agentKey: 'agent-1', currentIndex: 0,
      stops: [{ file: FILE, startLine: 2, endLine: 2, anchor: anchor('A'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'A', isReply: false }] }],
    };
    const registration = setup(saved);
    await flush();
    expect(h.threads).toHaveLength(1);
    await (h.commands.get('maestriBridge.notes.close') as (thread: unknown) => Promise<void>)(h.threads[0]);
    expect(h.store.get(KEY)).toBeUndefined();
    const second = setup(h.store.get(KEY));
    await flush();
    expect(h.threads).toHaveLength(0);
    expect(h.reveals).toHaveLength(0);
    second.dispose();
    registration.dispose();
  });

  it('dois slots voltam no mesmo lote sem inverter a ordem', async () => {
    h.docs.set(FILE, makeDoc(['x', ' divergente', ' divergente', 'C', 'fim']) as never);
    const saved = {
      version: 1, agentKey: 'agent-1', currentIndex: 0,
      stops: [
        { file: FILE, startLine: 2, endLine: 2, anchor: anchor('A'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'A', isReply: false }] },
        { file: FILE, startLine: 3, endLine: 3, anchor: anchor('B'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'B', isReply: false }] },
      ],
    };
    const registration = setup(saved);
    await flush();
    h.docs.set(FILE, makeDoc(['x', 'A', 'B', 'C', 'fim']) as never);
    await (h.commands.get('maestriBridge.notes.resume') as () => Promise<void>)();
    const after = h.store.get(KEY) as { stops: Array<{ comments: Array<{ text: string }> }> };
    expect(after.stops.map((note) => note.comments[0]!.text)).toEqual(['A', 'B']);
    expect(h.threads).toHaveLength(2);
    registration.dispose();
  });

  it('--new descarta slots do tour anterior e nao ressuscita apos retry', async () => {
    h.docs.set(FILE, makeDoc(['x', ' divergente', ' divergente', 'C', 'fim']) as never);
    const saved = {
      version: 1, agentKey: 'agent-1', currentIndex: 0,
      stops: [
        { file: FILE, startLine: 2, endLine: 2, anchor: anchor('A'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'A', isReply: false }] },
        { file: FILE, startLine: 3, endLine: 3, anchor: anchor('B'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'B', isReply: false }] },
      ],
    };
    const registration = setup(saved);
    await flush();
    await newNote('novo tour', '4-4', true);
    h.docs.set(FILE, makeDoc(['x', 'A', 'B', 'C', 'fim']) as never);
    await (h.commands.get('maestriBridge.notes.retry') as (() => Promise<void>) | undefined)?.()
      ?? (h.commands.get('maestriBridge.notes.resume') as () => Promise<void>)();
    const after = h.store.get(KEY) as { stops: Array<{ comments: Array<{ text: string }> }> };
    expect(after.stops.map((note) => note.comments[0]!.text)).toEqual(['novo tour']);
    registration.dispose();
  });

  it('ultima thread fechada com slots ausentes persiste somente o que falta', async () => {
    h.docs.set(FILE, makeDoc(['x', ' divergente', 'B', 'fim']) as never);
    const saved = {
      version: 1, agentKey: 'agent-1', currentIndex: 0,
      stops: [
        { file: FILE, startLine: 2, endLine: 2, anchor: anchor('A'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'A', isReply: false }] },
        { file: FILE, startLine: 3, endLine: 3, anchor: anchor('B'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'B', isReply: false }] },
      ],
    };
    const registration = setup(saved);
    await flush();
    expect(h.threads).toHaveLength(1);
    await (h.commands.get('maestriBridge.notes.close') as (thread: unknown) => Promise<void>)(h.threads[0]);
    const after = h.store.get(KEY) as { stops: Array<{ comments: Array<{ text: string }> }>; currentIndex: number };
    expect(after.stops.map((note) => note.comments[0]!.text)).toEqual(['A']);
    expect(after.currentIndex).toBe(0);
    registration.dispose();
  });

  it('Clear apaga o tour restaurado sem revelar notas', async () => {
    h.docs.set(FILE, makeDoc(['inicio', 'const a = 1;', 'const b = 2;', 'fim']) as never);
    const saved = {
      version: 1,
      agentKey: 'agent-1',
      currentIndex: 0,
      stops: [
        { file: FILE, startLine: 2, endLine: 3, anchor: anchor('const a = 1;\nconst b = 2;'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'limpar', isReply: false }] },
      ],
    };
    const registration = setup(saved);
    await flush();
    expect(h.threads).toHaveLength(1);
    await (h.commands.get('maestriBridge.notes.clearAll') as () => Promise<void>)();
    expect(h.store.get(KEY)).toBeUndefined();
    expect(h.reveals).toHaveLength(0);
    registration.dispose();
  });

  it('trecho identico deslocado e realocado em snapshot v1 somente com hash', async () => {
    const lines = ['cabecalho', 'linha neutra', 'const a = 1;', 'const b = 2;', 'fim'];
    h.docs.set(FILE, makeDoc(lines) as never);
    const saved = {
      version: 1,
      agentKey: 'agent-1',
      currentIndex: 0,
      stops: [
        { file: FILE, startLine: 1, endLine: 2, anchor: anchor('const a = 1;\nconst b = 2;'), name: 'Maia', viewed: false, comments: [{ author: 'Maia', text: 'movida', isReply: false }] },
      ],
    };
    const registration = setup(saved);
    await flush();
    // A realocacao aparece na thread restaurada (0-based) sem reescrever o snapshot.
    expect(h.threads).toHaveLength(1);
    const range = h.threads[0]!.range as { start: number; end: number };
    expect(range.start).toBe(2);
    expect(range.end).toBe(3);
    const result = h.store.get(KEY) as { stops: Array<{ comments: Array<{ text: string }> }> };
    expect(result.stops).toHaveLength(1);
    expect(result.stops[0]!.comments[0]!.text).toBe('movida');
    registration.dispose();
  });
});
