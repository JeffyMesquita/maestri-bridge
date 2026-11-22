import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentFollow } from '../src/agent-follow.ts';
import type { FollowChange, FollowWatchHandlers } from '../src/follow-watch.ts';

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
    selection: new EventEmitter<{ kind?: number }>(),
    folders: new EventEmitter<{ removed: unknown[] }>(),
    credentials: new EventEmitter<void>(),
    warning: vi.fn(),
    pick: vi.fn(),
    show: vi.fn<(change: FollowChange, current: () => boolean) => Promise<boolean>>(),
    open: vi.fn<(root: unknown, handlers: FollowWatchHandlers) => { dispose: () => void }>(),
    stop: vi.fn(),
    workspace: { isTrusted: true, workspaceFolders: [] as unknown[] },
  };
});

vi.mock('vscode', () => ({
  EventEmitter: host.EventEmitter,
  TextEditorSelectionChangeKind: { Mouse: 1, Keyboard: 2, Command: 3 },
  window: {
    onDidChangeTextEditorSelection: host.selection.event,
    showWarningMessage: host.warning,
    showQuickPick: host.pick,
  },
  workspace: Object.assign(host.workspace, { onDidChangeWorkspaceFolders: host.folders.event }),
}));
vi.mock('../src/follow-watch.ts', () => ({ watchFollowFiles: host.open }));
vi.mock('../src/follow-editor.ts', () => ({
  FollowEditor: class {
    readonly show = host.show;
    begin(): void {}
    clear(): void {}
    dispose(): void {}
  },
}));
vi.mock('../src/i18n/index.ts', () => ({ t: (key: string) => key }));

const path = resolve('project');
const folder = { name: 'project', uri: { scheme: 'file', fsPath: path, toString: () => path } };
const target = { workspaceId: 'w', workspaceName: 'project', terminalId: 't', terminalName: 'agent' };
const change = { file: 'a.ts', baseline: 'before', saved: 'after', line: 0 };

function makeFollow(workingDirectory = path): AgentFollow {
  return new AgentFollow(
    { session: { onDidChangeCredentials: host.credentials.event } } as never,
    { workspaces: [{ id: target.workspaceId, workingDirectory }] } as never,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  host.show.mockResolvedValue(true);
  host.open.mockReturnValue({ dispose: host.stop });
  host.workspace.isTrusted = true;
  host.workspace.workspaceFolders = [folder];
});

describe('AgentFollow', () => {
  it('uses the matching trusted folder and stops collecting when Chat changes target', async () => {
    const follow = makeFollow();
    await follow.toggle(target);
    const watch = host.open.mock.calls[0]![1];
    expect(host.open.mock.calls[0]![0]).toBe(folder.uri);
    expect(follow.summary?.phase).toBe('starting');
    watch.ready();
    follow.setChatTarget({ ...target });
    expect(follow.summary?.phase).toBe('following');
    follow.setChatTarget({ ...target, terminalId: 'other' });
    expect(follow.summary).toBeUndefined();
    expect(host.stop).toHaveBeenCalledOnce();
    watch.change(change);
    expect(host.show).not.toHaveBeenCalled();
    follow.dispose();
  });

  it('does not pause for programmatic selections and catches up on human input without another save', async () => {
    const follow = makeFollow();
    await follow.toggle(target);
    const watch = host.open.mock.calls[0]![1];
    watch.ready();
    host.selection.fire({ kind: 3 });
    host.selection.fire({});
    expect(follow.summary?.phase).toBe('following');
    host.selection.fire({ kind: 1 });
    watch.change(change);
    const edit = { ...change, saved: 'latest' };
    watch.change(edit);
    expect(follow.summary).toMatchObject({ phase: 'paused', pendingCount: 1 });
    expect(host.show).not.toHaveBeenCalled();
    await follow.viewPending();
    expect(host.show).toHaveBeenCalledWith(edit, expect.any(Function));
    expect(follow.summary).toMatchObject({ phase: 'following', pendingCount: 0 });
    follow.dispose();
  });

  it('asks for an explicit folder when the Wire path cannot identify an open folder', async () => {
    const follow = makeFollow(resolve('unrelated'));
    host.pick.mockResolvedValue(undefined);
    await follow.toggle(target);
    expect(host.pick).toHaveBeenCalledWith([expect.objectContaining({ folder })], expect.any(Object));
    expect(host.open).not.toHaveBeenCalled();
    expect(follow.summary).toBeUndefined();
    host.workspace.isTrusted = false;
    await follow.toggle(target);
    expect(host.pick).toHaveBeenCalledOnce();
    expect(host.open).not.toHaveBeenCalled();
    follow.dispose();
  });
});
