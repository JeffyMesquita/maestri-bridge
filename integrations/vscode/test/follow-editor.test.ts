import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { FollowEditor } from '../src/follow-editor.ts';

const host = vi.hoisted(() => {
  class EventEmitter<T> {
    readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  return {
    EventEmitter,
    documents: new EventEmitter<void>(),
    editors: new EventEmitter<void>(),
    visible: [] as Array<{ document: { uri: unknown; getText: () => string; lineCount: number }; revealRange: ReturnType<typeof vi.fn>; viewColumn: number }>,
    execute: vi.fn(),
    register: vi.fn(),
    activeGroup: { viewColumn: 1, activeTab: undefined as { input: unknown } | undefined },
  };
});

vi.mock('vscode', () => ({
  EventEmitter: host.EventEmitter,
  Uri: {
    from: (value: { scheme: string; path: string; query: string }) => ({
      ...value,
      toString: () => value.scheme + ':' + value.path + '?' + value.query,
    }),
  },
  workspace: {
    onDidChangeTextDocument: host.documents.event,
    onDidCloseTextDocument: () => ({ dispose: vi.fn() }),
    registerTextDocumentContentProvider: host.register,
  },
  window: {
    onDidChangeVisibleTextEditors: host.editors.event,
    visibleTextEditors: host.visible,
    tabGroups: { activeTabGroup: host.activeGroup },
  },
  commands: { executeCommand: host.execute },
  TabInputWebview: class {},
  ViewColumn: { Beside: -2 },
  Range: class {
    constructor(readonly start: number, readonly startColumn: number, readonly end: number, readonly endColumn: number) {}
  },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
}));

const first = { file: 'src/a.ts', baseline: 'initial', saved: 'initial\nfirst', line: 1 };
const provider = () => host.register.mock.calls.at(-1)?.[1] as vscode.TextDocumentContentProvider;

beforeEach(() => {
  vi.clearAllMocks();
  host.visible.length = 0;
  host.activeGroup.activeTab = undefined;
  host.register.mockReturnValue({ dispose: vi.fn() });
  host.execute.mockResolvedValue(undefined);
});

describe('FollowEditor', () => {
  it('opens the native diff without taking focus and uses saved snapshots', async () => {
    const editor = new FollowEditor();
    editor.begin();
    await editor.show(first, () => true);
    const [command, left, right, title, options] = host.execute.mock.calls[0]!;
    expect(command).toBe('vscode.diff');
    expect(title).toBe(first.file);
    expect(options).toEqual({ preserveFocus: true, preview: true, viewColumn: 1 });
    expect(provider().provideTextDocumentContent(left, {} as vscode.CancellationToken)).toBe('initial');
    expect(provider().provideTextDocumentContent(right, {} as vscode.CancellationToken)).toBe('initial\nfirst');
    editor.dispose();
  });

  it('reveals the latest saved line only after the displayed document updates', async () => {
    const editor = new FollowEditor();
    editor.begin();
    await editor.show(first, () => true);
    const right = host.execute.mock.calls[0]![2];
    const revealRange = vi.fn();
    let saved = first.saved;
    host.visible.push({ document: { uri: right, getText: () => saved, lineCount: 3 }, revealRange, viewColumn: 1 });
    host.editors.fire();
    revealRange.mockClear();
    await editor.show({ ...first, saved: 'initial\nfirst\nlatest', line: 2 }, () => true);
    expect(revealRange).not.toHaveBeenCalled();
    saved = 'initial\nfirst\nlatest';
    host.documents.fire();
    expect(revealRange).toHaveBeenCalledWith(expect.objectContaining({ start: 2, end: 2 }), 2);
    editor.dispose();
  });

  it('keeps the Chat panel visible and discards deferred reveals after cancellation', async () => {
    const editor = new FollowEditor();
    host.activeGroup.activeTab = { input: new vscode.TabInputWebview('chat') };
    editor.begin();
    let current = true;
    await editor.show(first, () => current);
    expect(host.execute.mock.calls[0]![4]).toMatchObject({ viewColumn: -2 });
    current = false;
    const revealRange = vi.fn();
    host.visible.push({ document: { uri: host.execute.mock.calls[0]![2], getText: () => first.saved, lineCount: 2 }, revealRange, viewColumn: 2 });
    host.editors.fire();
    expect(revealRange).not.toHaveBeenCalled();
    editor.dispose();
  });
});
