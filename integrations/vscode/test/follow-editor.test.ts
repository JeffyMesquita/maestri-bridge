import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activityRevision } from '@maestri-bridge/core';
import { FollowEditor } from '../src/follow-editor.ts';
import type { FollowActivity } from '../src/follow-state.ts';

const mock = vi.hoisted(() => {
  const thread = { dispose: vi.fn(), label: '', canReply: false, collapsibleState: 0 };
  return {
    open: vi.fn(), show: vi.fn(), resolve: vi.fn(), decorate: vi.fn(), reveal: vi.fn(),
    note: vi.fn((..._args: unknown[]) => thread), dispose: vi.fn(), thread,
  };
});
vi.mock('../src/follow-file.ts', () => ({ resolveFollowFile: mock.resolve }));
vi.mock('vscode', () => ({
  window: {
    createTextEditorDecorationType: () => ({ dispose: mock.dispose }),
    showTextDocument: mock.show,
    activeTextEditor: { viewColumn: 2 },
  },
  workspace: { openTextDocument: mock.open },
  comments: { createCommentController: () => ({ createCommentThread: mock.note, dispose: mock.dispose }) },
  ThemeColor: class { constructor(public id: string) {} },
  Range: class { constructor(public startLine: number, public startColumn: number, public endLine: number, public endColumn: number) {} },
  MarkdownString: class { value = ''; appendText(value: string) { this.value = value; return this; } },
  Uri: { file: (path: string) => ({ fsPath: path, toString: () => path }) },
  ViewColumn: { Active: -1 }, TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  CommentMode: { Preview: 0 }, CommentThreadCollapsibleState: { Expanded: 1 },
}));

const text = 'one\ntwo\n';
const activity: FollowActivity = {
  v: 1, sessionId: 'session', agentId: 'agent', seq: 1, kind: 'focus',
  file: 'a.ts', range: { startLine: 1, endLine: 2 }, revision: activityRevision(text),
};
const root = { fsPath: '/project' } as Parameters<FollowEditor['show']>[0];
const document = () => ({ isDirty: false, isClosed: false, getText: () => text, lineCount: 3, lineAt: () => ({ text: 'two' }) });

beforeEach(() => {
  vi.clearAllMocks();
  mock.resolve.mockResolvedValue('/project/a.ts');
  mock.open.mockResolvedValue(document());
  mock.show.mockResolvedValue({ visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal });
});

describe('follow editor adapter', () => {
  it('preserves focus and selection and reveals only the verified range', async () => {
    const editor = new FollowEditor(); editor.begin();
    expect(await editor.show(root, activity, 'Senku', () => true)).toBe(true);
    expect(mock.show.mock.calls[0]?.[1]).toEqual({ preserveFocus: true, preview: true, viewColumn: 2 });
    expect(mock.decorate).toHaveBeenCalledOnce();
    expect(mock.reveal).toHaveBeenCalledOnce();
    expect(mock.note).not.toHaveBeenCalled();
    editor.dispose();
  });
  it('does not scroll when the range is already visible', async () => {
    mock.show.mockResolvedValue({ visibleRanges: [{ contains: () => true }], setDecorations: mock.decorate, revealRange: mock.reveal });
    await new FollowEditor().show(root, activity, 'Senku', () => true);
    expect(mock.reveal).not.toHaveBeenCalled();
  });
  it.each(['dirty', 'stale', 'range'])('refuses %s documents without opening an editor', async (kind) => {
    mock.open.mockResolvedValue({ ...document(), isDirty: kind === 'dirty', getText: () => kind === 'stale' ? 'changed' : text });
    const event = kind === 'range' ? { ...activity, range: { startLine: 1, endLine: 5 } } : activity;
    expect(await new FollowEditor().show(root, event, 'Senku', () => true)).toBe(false);
    expect(mock.show).not.toHaveBeenCalled();
  });
  it('cancels after an awaited document open when the human pauses', async () => {
    let current = true;
    mock.open.mockImplementation(async () => { current = false; return document(); });
    expect(await new FollowEditor().show(root, activity, 'Senku', () => current)).toBe(false);
    expect(mock.show).not.toHaveBeenCalled();
  });
  it('does not decorate or reveal after the session changes during showTextDocument', async () => {
    let current = true;
    mock.show.mockImplementation(async () => { current = false; return { visibleRanges: [], setDecorations: mock.decorate, revealRange: mock.reveal }; });
    expect(await new FollowEditor().show(root, activity, 'Senku', () => current)).toBe(false);
    expect(mock.decorate).not.toHaveBeenCalled();
    expect(mock.reveal).not.toHaveBeenCalled();
  });
  it('keeps one decision thread and disposes it before the next update', async () => {
    const editor = new FollowEditor();
    await editor.show(root, { ...activity, kind: 'decision', message: 'Validate before saving' }, 'Senku', () => true);
    expect(mock.note).toHaveBeenCalledOnce();
    expect(mock.thread.canReply).toBe(true);
    const comments = mock.note.mock.calls[0]?.[2] as Array<{ body: { value: string } }>;
    expect(comments[0]?.body.value).toBe('Validate before saving');
    await editor.show(root, { ...activity, seq: 2 }, 'Senku', () => true);
    expect(mock.thread.dispose).toHaveBeenCalledOnce();
  });
  it('does not access a missing or excluded physical file', async () => {
    mock.resolve.mockResolvedValue(undefined);
    expect(await new FollowEditor().show(root, activity, 'Senku', () => true)).toBe(false);
    expect(mock.open).not.toHaveBeenCalled();
  });
});
