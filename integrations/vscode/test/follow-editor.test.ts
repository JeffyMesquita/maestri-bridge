import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityRevision } from '@maestri-bridge/core';
import { FollowEditor } from '../src/follow-editor.ts';
import type { FollowActivity } from '../src/follow-state.ts';

const mock = vi.hoisted(() => {
  return {
    open: vi.fn(), show: vi.fn(), resolve: vi.fn(), decorate: vi.fn(), reveal: vi.fn(),
    note: vi.fn(), dispose: vi.fn(), config: vi.fn(), changed: vi.fn(),
  };
});
vi.mock('../src/follow-file.ts', () => ({ resolveFollowFile: mock.resolve }));
vi.mock('vscode', () => ({
  window: {
    createTextEditorDecorationType: () => ({ dispose: mock.dispose }),
    showTextDocument: mock.show,
    activeTextEditor: { viewColumn: 2, document: { uri: { toString: () => '/project/previous.ts' } } },
  },
  workspace: {
    openTextDocument: mock.open, getConfiguration: () => ({ get: mock.config }),
    onDidChangeTextDocument: mock.changed,
  },
  comments: { createCommentController: () => ({ createCommentThread: mock.note, dispose: mock.dispose }) },
  ThemeColor: class { constructor(public id: string) {} },
  Range: class {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(startLine: number, startColumn: number, endLine: number, endColumn: number) {
      this.start = { line: startLine, character: startColumn };
      this.end = { line: endLine, character: endColumn };
    }
  },
  MarkdownString: class { value = ''; appendText(value: string) { this.value = value; return this; } },
  Uri: { file: (path: string) => ({ fsPath: path, toString: () => path }) },
  ViewColumn: { Active: -1, Beside: -2 }, TextEditorRevealType: { InCenter: 1 }, OverviewRulerLane: { Center: 2 },
  CommentMode: { Preview: 0 }, CommentThreadCollapsibleState: { Expanded: 1 },
}));

const text = 'one\ntwo\n';
const activity: FollowActivity = {
  v: 1, sessionId: 'session', agentId: 'agent', seq: 1, kind: 'focus',
  file: 'a.ts', range: { startLine: 1, endLine: 2 }, revision: activityRevision(text),
};
const root = { fsPath: '/project' } as Parameters<FollowEditor['show']>[0];
const document = () => ({ isDirty: false, isClosed: false, version: 1, getText: () => text, lineCount: 3, lineAt: () => ({ text: 'two' }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mock.config.mockReturnValue('auto');
  mock.changed.mockReturnValue({ dispose: vi.fn() });
  mock.resolve.mockResolvedValue('/project/a.ts');
  const opened = document();
  mock.open.mockResolvedValue(opened);
  mock.show.mockResolvedValue({ document: opened, visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('follow editor adapter', () => {
  it('preserves focus and selection and reveals only the verified range', async () => {
    const editor = new FollowEditor(); editor.begin();
    expect(await editor.show(root, activity, () => true)).toBe(true);
    expect(mock.show.mock.calls[0]?.[1]).toEqual({ preserveFocus: true, preview: true, viewColumn: 2 });
    expect(mock.decorate).toHaveBeenCalledOnce();
    expect(mock.reveal).toHaveBeenCalledOnce();
    expect(mock.reveal.mock.calls[0]?.[1]).toBe(1);
    expect(mock.note).not.toHaveBeenCalled();
    editor.dispose();
  });
  it('does not scroll when the range is already visible', async () => {
    mock.show.mockResolvedValue({ document: document(), visibleRanges: [{ contains: () => true }], setDecorations: mock.decorate, revealRange: mock.reveal });
    await new FollowEditor().show(root, activity, () => true);
    expect(mock.reveal).not.toHaveBeenCalled();
  });
  it('opens beside once and reuses the resulting group', async () => {
    mock.show.mockResolvedValue({ document: document(), viewColumn: 3, visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal });
    const editor = new FollowEditor();
    editor.begin(true);
    await editor.show(root, activity, () => true);
    await editor.show(root, { ...activity, seq: 2 }, () => true);
    expect(mock.show.mock.calls.map(([, options]) => options.viewColumn)).toEqual([-2, 3]);
  });
  it('recognizes the old editor during navigation and the new viewport while it settles', async () => {
    const editor = new FollowEditor();
    const target = { toString: () => '/project/a.ts' } as Parameters<FollowEditor['isOwnNavigation']>[0];
    const previous = { toString: () => '/project/previous.ts' } as typeof target;
    const unrelated = { toString: () => '/project/other.ts' } as typeof target;
    mock.show.mockImplementation(async () => {
      expect(editor.isOwnNavigation(previous)).toBe(true);
      expect(editor.isOwnNavigation(target)).toBe(true);
      expect(editor.isOwnNavigation(unrelated)).toBe(false);
      return { document: document(), visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal };
    });
    vi.useFakeTimers();
    try {
      expect(await editor.show(root, activity, () => true)).toBe(true);
      expect(editor.isOwnNavigation(previous)).toBe(false);
      expect(editor.isOwnNavigation(target)).toBe(true);
      vi.advanceTimersByTime(350);
      expect(editor.isOwnNavigation(target)).toBe(false);
    } finally {
      vi.useRealTimers();
      editor.dispose();
    }
  });
  it.each(['dirty', 'stale', 'range'])('refuses %s documents without opening an editor', async (kind) => {
    mock.open.mockResolvedValue({ ...document(), isDirty: kind === 'dirty', getText: () => kind === 'stale' ? 'changed' : text });
    const event = kind === 'range' ? { ...activity, range: { startLine: 1, endLine: 5 } } : activity;
    expect(await new FollowEditor().show(root, event, () => true)).toBe(false);
    expect(mock.show).not.toHaveBeenCalled();
  });
  it('cancels after an awaited document open when the human pauses', async () => {
    let current = true;
    mock.open.mockImplementation(async () => { current = false; return document(); });
    expect(await new FollowEditor().show(root, activity, () => current)).toBe(false);
    expect(mock.show).not.toHaveBeenCalled();
  });
  it('does not decorate or reveal after the session changes during showTextDocument', async () => {
    let current = true;
    mock.show.mockImplementation(async () => { current = false; return { visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal }; });
    expect(await new FollowEditor().show(root, activity, () => current)).toBe(false);
    expect(mock.decorate).not.toHaveBeenCalled();
    expect(mock.reveal).not.toHaveBeenCalled();
  });
  it('shows a decision without creating an inline comment', async () => {
    const editor = new FollowEditor();
    expect(await editor.show(root, { ...activity, kind: 'decision', message: 'Validate before saving' }, () => true)).toBe(true);
    expect(mock.note).not.toHaveBeenCalled();
    expect(mock.decorate).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1200);
    expect(mock.decorate.mock.lastCall?.[1]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['on', 'auto'])('keeps the full range static with reduced motion %s', async (motion) => {
    mock.config.mockReturnValue(motion);
    await new FollowEditor().show(root, activity, () => true);
    expect(mock.decorate.mock.lastCall?.[1][0]).toMatchObject({ start: { line: 0 }, end: { line: 1 } });
    vi.advanceTimersByTime(200);
    expect(mock.decorate).toHaveBeenCalledOnce();
  });
  it('sweeps the highlight quickly without changing the document, then clears it', async () => {
    mock.config.mockReturnValue('off');
    const opened = document();
    const edit = vi.fn();
    mock.show.mockResolvedValue({ document: opened, edit, visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal });
    await new FollowEditor().show(root, activity, () => true);
    expect(mock.decorate.mock.lastCall?.[1][0].end.line).toBe(0);
    vi.advanceTimersByTime(160);
    expect(mock.decorate.mock.lastCall?.[1][0].end.line).toBe(1);
    expect(opened.getText()).toBe(text);
    expect(edit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1200);
    expect(mock.decorate.mock.lastCall?.[1]).toEqual([]);
  });
  it.each(['paused', 'dirty', 'closed', 'changed'])('cancels the sweep when the document or session becomes %s', async (reason) => {
    mock.config.mockReturnValue('off');
    const opened = document();
    let current = true;
    mock.show.mockResolvedValue({ document: opened, visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal });
    await new FollowEditor().show(root, activity, () => current);
    if (reason === 'paused') current = false;
    if (reason === 'dirty') opened.isDirty = true;
    if (reason === 'closed') opened.isClosed = true;
    if (reason === 'changed') opened.version++;
    vi.advanceTimersByTime(160);
    expect(mock.decorate.mock.lastCall?.[1]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels an earlier emphasis when a new location arrives', async () => {
    const editor = new FollowEditor();
    await editor.show(root, activity, () => true);
    vi.advanceTimersByTime(1000);
    await editor.show(root, { ...activity, seq: 2, range: { startLine: 2, endLine: 2 } }, () => true);
    vi.advanceTimersByTime(200);
    expect(mock.decorate.mock.lastCall?.[1][0].start.line).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(mock.decorate.mock.lastCall?.[1]).toEqual([]);
  });
  it('immediately clears a held highlight after an external saved update', async () => {
    const opened = document();
    mock.show.mockResolvedValue({ document: opened, visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal });
    const editor = new FollowEditor();
    await editor.show(root, activity, () => true);
    const changed = mock.changed.mock.lastCall?.[0] as (event: { document: typeof opened }) => void;
    changed({ document: document() });
    expect(mock.decorate).toHaveBeenCalledOnce();
    opened.version++;
    changed({ document: opened });
    expect(mock.decorate.mock.lastCall?.[1]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    editor.dispose();
    expect(mock.changed.mock.results[0]?.value.dispose).toHaveBeenCalledOnce();
  });
  it('bounds a large range sweep to eight paints', async () => {
    mock.config.mockReturnValue('off');
    const content = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
    const opened = { ...document(), getText: () => content, lineCount: 100 };
    mock.open.mockResolvedValue(opened);
    mock.show.mockResolvedValue({ document: opened, visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal });
    await new FollowEditor().show(root, { ...activity, range: { startLine: 1, endLine: 100 }, revision: activityRevision(content) }, () => true);
    vi.advanceTimersByTime(160);
    expect(mock.decorate).toHaveBeenCalledTimes(8);
    expect(mock.decorate.mock.lastCall?.[1][0].end.line).toBe(99);
    expect(opened.getText()).toBe(content);
  });
  it.each(['cancelEmphasis', 'clear', 'dispose'] as const)('cancels every pending frame on %s', async (method) => {
    mock.config.mockReturnValue('off');
    const editor = new FollowEditor();
    await editor.show(root, activity, () => true);
    editor[method]();
    const calls = mock.decorate.mock.calls.length;
    vi.runAllTimers();
    expect(mock.decorate.mock.calls.length).toBe(calls);
    expect(mock.decorate.mock.lastCall?.[1]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not access a missing or excluded physical file', async () => {
    mock.resolve.mockResolvedValue(undefined);
    expect(await new FollowEditor().show(root, activity, () => true)).toBe(false);
    expect(mock.open).not.toHaveBeenCalled();
  });
});
