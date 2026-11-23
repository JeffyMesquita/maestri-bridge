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

const savedContent = (uri: vscode.Uri) =>
  provider().provideTextDocumentContent(uri, {} as vscode.CancellationToken);

function showDocument(uri: unknown, getText: () => string, viewColumn = 1) {
  const revealRange = vi.fn();
  host.visible.push({ document: { uri, getText, lineCount: 3 }, revealRange, viewColumn });
  host.editors.fire();
  return revealRange;
}

describe('FollowEditor', () => {
  it('opens the native diff without taking focus and uses saved snapshots', async () => {
    const editor = new FollowEditor();
    try {
      editor.begin();
      const opening = editor.show(first, () => true);
      const [command, left, right, title, options] = host.execute.mock.calls[0]!;
      expect(command).toBe('vscode.diff');
      expect(title).toBe(first.file);
      expect(options).toEqual({ preserveFocus: true, preview: true, viewColumn: 1 });
      expect(savedContent(left)).toBe('initial');
      expect(savedContent(right)).toBe('initial\nfirst');
      showDocument(right, () => first.saved);
      await expect(opening).resolves.toBe(true);
    } finally {
      editor.dispose();
    }
  });

  it('confirms success only after the visible diff reveals the updated line', async () => {
    vi.useFakeTimers();
    const editor = new FollowEditor();
    try {
      editor.begin();
      const opening = editor.show(first, () => true);
      const right = host.execute.mock.calls[0]![2];
      let saved = first.saved;
      const revealRange = showDocument(right, () => saved);
      await opening;
      revealRange.mockClear();
      let shown: boolean | undefined;
      const updating = editor.show({ ...first, saved: 'initial\nfirst\nlatest', line: 2 }, () => true)
        .then((value) => { shown = value; });
      await vi.advanceTimersByTimeAsync(0);
      expect(shown).toBeUndefined();
      expect(revealRange).not.toHaveBeenCalled();
      saved = 'initial\nfirst\nlatest';
      host.documents.fire();
      await updating;
      expect(shown).toBe(true);
      expect(revealRange).toHaveBeenCalledWith(expect.objectContaining({ start: 2, end: 2 }), 2);
    } finally {
      editor.dispose();
      vi.useRealTimers();
    }
  });

  it('cleans up both snapshots and the deferred reveal when opening the diff fails', async () => {
    const editor = new FollowEditor();
    try {
      editor.begin();
      host.execute.mockRejectedValueOnce(new Error('diff rejected'));
      const opening = editor.show(first, () => true);
      const [, before, after] = host.execute.mock.calls[0]!;
      await expect(opening).resolves.toBe(false);
      expect(savedContent(before)).toBe('');
      expect(savedContent(after)).toBe('');
      expect(showDocument(after, () => first.saved)).not.toHaveBeenCalled();
    } finally {
      editor.dispose();
    }
  });

  it('bounds the wait even when the diff command never resolves', async () => {
    vi.useFakeTimers();
    const editor = new FollowEditor();
    try {
      editor.begin();
      host.execute.mockImplementationOnce(() => new Promise<void>(() => {}));
      let shown: boolean | undefined;
      void editor.show(first, () => true).then((value) => { shown = value; });
      const [, before, after] = host.execute.mock.calls[0]!;
      await vi.advanceTimersByTimeAsync(2000);
      expect(shown).toBe(false);
      expect(savedContent(before)).toBe('');
      expect(savedContent(after)).toBe('');
    } finally {
      editor.dispose();
      vi.useRealTimers();
    }
  });

  it('restores the previous visible snapshots if an update fails', async () => {
    const editor = new FollowEditor();
    try {
      editor.begin();
      const initial = editor.show(first, () => true);
      const [, before, after] = host.execute.mock.calls[0]!;
      const revealRange = showDocument(after, () => first.saved);
      await initial;
      revealRange.mockClear();
      host.execute.mockRejectedValueOnce(new Error('diff rejected'));
      await expect(editor.show({ ...first, saved: 'other text' }, () => true)).resolves.toBe(false);
      expect(savedContent(before)).toBe(first.baseline);
      expect(savedContent(after)).toBe(first.saved);
      expect(revealRange).not.toHaveBeenCalled();
    } finally {
      editor.dispose();
    }
  });

  it('isolates a late failure after stopping from the next diff', async () => {
    const editor = new FollowEditor();
    try {
      editor.begin();
      let rejectPrevious: (error: Error) => void = () => undefined;
      host.execute.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectPrevious = reject; }));
      const stopped = editor.show(first, () => true);
      editor.clear();
      await expect(stopped).resolves.toBe(false);
      editor.begin();
      const newChange = { ...first, saved: 'new session' };
      const opening = editor.show(newChange, () => true);
      const [, before, after] = host.execute.mock.calls[1]!;
      rejectPrevious(new Error('late rejection'));
      await Promise.resolve();
      showDocument(after, () => newChange.saved);
      await expect(opening).resolves.toBe(true);
      expect(savedContent(before)).toBe(newChange.baseline);
      expect(savedContent(after)).toBe(newChange.saved);
    } finally {
      editor.dispose();
    }
  });

  it('keeps the Chat panel visible and discards deferred reveals after cancellation', async () => {
    const editor = new FollowEditor();
    try {
      host.activeGroup.activeTab = { input: new vscode.TabInputWebview('chat') };
      editor.begin();
      let current = true;
      const opening = editor.show(first, () => current);
      expect(host.execute.mock.calls[0]![4]).toMatchObject({ viewColumn: -2 });
      current = false;
      const revealRange = showDocument(host.execute.mock.calls[0]![2], () => first.saved, 2);
      await expect(opening).resolves.toBe(false);
      expect(revealRange).not.toHaveBeenCalled();
    } finally {
      editor.dispose();
    }
  });
});
