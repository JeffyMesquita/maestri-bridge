import { resolve } from 'node:path';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    cancelPending: vi.fn(),
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
    readonly cancelPending = host.cancelPending;
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
  it('waits for collection and slow reads before opening only the newest change', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      watch.activity?.(true);
      for (let index = 0; index < 30; index++) {
        watch.change({ ...change, file: `b${index}.ts` });
        await vi.advanceTimersByTimeAsync(160);
        expect(host.show).not.toHaveBeenCalled();
      }
      watch.activity?.(false);
      await vi.advanceTimersByTimeAsync(120);
      expect(host.show).toHaveBeenCalledExactlyOnceWith({ ...change, file: 'b29.ts' }, expect.any(Function));
      expect(follow.summary?.pendingCount).toBe(0);
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });

  it('withdraws a scheduled preview when the watcher receives another raw event', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      watch.change(change);
      await vi.advanceTimersByTimeAsync(60);
      watch.activity?.(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(host.show).not.toHaveBeenCalled();
      const newest = { ...change, file: 'b.ts' };
      watch.change(newest);
      watch.activity?.(false);
      await vi.advanceTimersByTimeAsync(120);
      expect(host.show).toHaveBeenCalledExactlyOnceWith(newest, expect.any(Function));
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });

  it('cancels an automatic attempt during collection without reporting a read failure', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    let release: (value: boolean) => void = () => undefined;
    host.show.mockImplementationOnce(() => new Promise<boolean>((done) => { release = done; }));
    host.cancelPending.mockImplementation(() => release(false));
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      watch.change(change);
      await vi.advanceTimersByTimeAsync(120);
      expect(host.show).toHaveBeenCalledOnce();
      watch.activity?.(true);
      expect(host.cancelPending).toHaveBeenCalledOnce();
      const newest = { ...change, file: 'b.ts' };
      watch.change(newest);
      await vi.advanceTimersByTimeAsync(300);
      expect(host.show).toHaveBeenCalledOnce();
      expect(follow.summary?.error).not.toBe(true);
      watch.activity?.(false);
      await vi.advanceTimersByTimeAsync(120);
      expect(host.show.mock.calls.map(([item]) => item.file)).toEqual(['a.ts', 'b.ts']);
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });

  it('does not revive a cancelled attempt when collection settles before its promise resumes', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    let release: (value: boolean) => void = () => undefined;
    host.show.mockImplementationOnce(() => new Promise<boolean>((done) => { release = done; }));
    host.cancelPending.mockImplementation(() => release(false));
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      watch.change(change);
      await vi.advanceTimersByTimeAsync(120);
      watch.activity(true);
      watch.activity(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(follow.summary?.error).not.toBe(true);
      await vi.advanceTimersByTimeAsync(120);
      expect(host.show).toHaveBeenCalledTimes(2);
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });

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

  it('views the newest pending file directly without opening another picker', async () => {
    const follow = makeFollow();
    await follow.toggle(target);
    const watch = host.open.mock.calls[0]![1];
    watch.ready();
    host.selection.fire({ kind: 1 });
    watch.change(change);
    const latest = { ...change, file: 'b.ts', saved: 'newest' };
    watch.change(latest);
    await follow.viewPending();
    expect(host.pick).not.toHaveBeenCalled();
    expect(host.show).toHaveBeenCalledExactlyOnceWith(latest, expect.any(Function));
    expect(follow.summary).toMatchObject({ phase: 'following', pendingCount: 0 });
    follow.dispose();
  });

  it('bounds pending identities while preserving the latest change for View', async () => {
    const follow = makeFollow();
    await follow.toggle(target);
    const watch = host.open.mock.calls[0]![1];
    watch.ready();
    host.selection.fire({ kind: 1 });
    for (let index = 0; index < 20001; index++) watch.change({ ...change, file: `f${index}.ts` });
    expect(follow.summary).toMatchObject({ phase: 'paused', pendingCount: 20000, limited: true });
    await follow.viewPending();
    expect(host.show.mock.lastCall?.[0].file).toBe('f20000.ts');
    expect(follow.summary).toMatchObject({ phase: 'following', pendingCount: 0 });
    follow.dispose();
  });

  it('coalesces a thirty-file burst to the last event rather than filename order', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      for (let index = 0; index < 30; index++) watch.change({ ...change, file: `b${index}.ts` });
      await vi.advanceTimersByTimeAsync(200);
      expect(host.show).toHaveBeenCalledExactlyOnceWith({ ...change, file: 'b29.ts' }, expect.any(Function));
      expect(follow.summary?.pendingCount).toBe(0);
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps the latest save that arrives while a preview is opening', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    let release: (shown: boolean) => void = () => undefined;
    host.show.mockImplementationOnce(() => new Promise<boolean>((done) => { release = done; }));
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      watch.change(change);
      await vi.advanceTimersByTimeAsync(200);
      watch.change({ ...change, file: 'b.ts' });
      const latest = { ...change, file: 'c.ts', saved: 'last' };
      watch.change(latest);
      release(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(host.show.mock.calls.map(([item]) => item.file)).toEqual(['a.ts', 'c.ts']);
      expect(host.show.mock.lastCall?.[0]).toEqual(latest);
      expect(follow.summary?.pendingCount).toBe(0);
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });

  it('does not busy-loop an unavailable preview until another save arrives', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    host.show.mockResolvedValueOnce(false);
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      watch.change(change);
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.show).toHaveBeenCalledOnce();
      watch.change({ ...change, saved: 'retry' });
      await vi.advanceTimersByTimeAsync(200);
      expect(host.show).toHaveBeenCalledTimes(2);
      expect(follow.summary?.pendingCount).toBe(0);
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });

  it('retries a failed automatic preview only when a newer save arrived during the attempt', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    let release: (shown: boolean) => void = () => undefined;
    host.show
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(false);
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      watch.change(change);
      await vi.advanceTimersByTimeAsync(120);
      const newest = { ...change, saved: 'newest' };
      watch.change(newest);
      await vi.advanceTimersByTimeAsync(120);
      expect(host.show).toHaveBeenCalledOnce();
      release(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.show.mock.calls.map(([item]) => item)).toEqual([change, newest]);
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });

  it('reports a failed View and keeps the change pending while paused', async () => {
    const follow = makeFollow();
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      host.selection.fire({ kind: 1 });
      watch.change(change);
      host.show.mockResolvedValueOnce(false);
      await follow.viewPending();
      expect(follow.summary).toMatchObject({ phase: 'paused', pendingCount: 1, errorReason: 'readFailed' });
    } finally {
      follow.dispose();
    }
  });

  it('matches an open symlink folder to the mapped physical root', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'follow-map-'));
    const physical = join(temporary, 'actual');
    const link = join(temporary, 'linked');
    await mkdir(physical);
    await symlink(physical, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = { name: 'linked', uri: { scheme: 'file', fsPath: link, toString: () => link } };
    host.workspace.workspaceFolders = [linked];
    const follow = makeFollow(await realpath(physical));
    try {
      await follow.toggle(target);
      expect(host.pick).not.toHaveBeenCalled();
      expect(host.open.mock.calls[0]?.[0]).toBe(linked.uri);
    } finally {
      follow.dispose();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it.each(['rootUnavailable', 'rootChanged', 'snapshotFailed'] as const)('reports the actual fatal reason %s', async (reason) => {
    const follow = makeFollow();
    await follow.toggle(target);
    host.open.mock.calls[0]![1].error(true, reason);
    expect(follow.summary).toBeUndefined();
    expect(host.warning).toHaveBeenCalledExactlyOnceWith(`follow.${reason}`);
    follow.dispose();
  });

  it('keeps following with a partial snapshot without claiming a read error', async () => {
    const follow = makeFollow();
    await follow.toggle(target);
    const watch = host.open.mock.calls[0]![1];
    watch.error(false, 'snapshotLimited');
    watch.ready();
    expect(follow.summary).toMatchObject({ phase: 'following', limited: true });
    expect(follow.summary?.error).not.toBe(true);
    follow.dispose();
  });

  it('drops emitted payloads when the watcher invalidates rules before the auto timer', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      watch.change(change);
      watch.invalidate();
      await vi.advanceTimersByTimeAsync(300);
      expect(host.show).not.toHaveBeenCalled();
      expect(follow.summary).toMatchObject({ phase: 'following', pendingCount: 0 });
      expect(follow.summary?.error).not.toBe(true);
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });

  it('cancels a slow View when a later keyboard selection arrives and keeps the change pending', async () => {
    const follow = makeFollow();
    let release: (shown: boolean) => void = () => undefined;
    host.show.mockImplementationOnce(() => new Promise<boolean>((done) => { release = done; }));
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      host.selection.fire({ kind: 1 });
      watch.change(change);
      const viewing = follow.viewPending();
      host.selection.fire({ kind: 2 });
      expect(host.cancelPending).toHaveBeenCalled();
      release(false);
      await viewing;
      expect(follow.summary).toMatchObject({ phase: 'paused', pendingCount: 1 });
      expect(follow.summary?.error).not.toBe(true);
    } finally {
      follow.dispose();
    }
  });

  it('keeps the newer attempt alive when a cancelled one resolves past its window', async () => {
    vi.useFakeTimers();
    const follow = makeFollow();
    let release: (shown: boolean) => void = () => undefined;
    host.show.mockImplementationOnce(() => new Promise<boolean>((done) => { release = done; }));
    try {
      await follow.toggle(target);
      const watch = host.open.mock.calls[0]![1];
      watch.ready();
      watch.change(change);
      await vi.advanceTimersByTimeAsync(120);
      expect(host.show).toHaveBeenCalledOnce();
      watch.activity(true);
      watch.activity(false);
      await vi.advanceTimersByTimeAsync(120);
      expect(host.show).toHaveBeenCalledOnce();
      release(true);
      await vi.advanceTimersByTimeAsync(400);
      expect(host.show).toHaveBeenCalledTimes(2);
      expect(follow.summary?.pendingCount).toBe(0);
    } finally {
      follow.dispose();
      vi.useRealTimers();
    }
  });
});
