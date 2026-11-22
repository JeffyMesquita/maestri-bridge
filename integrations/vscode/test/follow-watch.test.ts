import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchFollowFiles, type FollowChange } from '../src/follow-watch.ts';

const mock = vi.hoisted(() => {
  const listeners: Record<'create' | 'change' | 'delete', ((uri: unknown) => void)[]> = {
    create: [], change: [], delete: [],
  };
  return {
    listeners,
    dispose: vi.fn(),
    create: vi.fn(() => ({
      onDidCreate: (fn: (uri: unknown) => void) => { listeners.create.push(fn); return { dispose: vi.fn() }; },
      onDidChange: (fn: (uri: unknown) => void) => { listeners.change.push(fn); return { dispose: vi.fn() }; },
      onDidDelete: (fn: (uri: unknown) => void) => { listeners.delete.push(fn); return { dispose: vi.fn() }; },
      dispose: () => mock.dispose(),
    })),
  };
});

vi.mock('vscode', () => ({
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
  workspace: { createFileSystemWatcher: mock.create },
}));

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
beforeEach(() => {
  vi.clearAllMocks();
  mock.listeners.create.length = 0;
  mock.listeners.change.length = 0;
  mock.listeners.delete.length = 0;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

async function project(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'maestri-watch-'));
  temporary.push(parent);
  const root = join(parent, 'project');
  await mkdir(root);
  return root;
}

function start(root: string) {
  const changes: FollowChange[] = [];
  const errors: boolean[] = [];
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const disposable = watchFollowFiles({ fsPath: root } as never, {
    change: (change) => changes.push(change),
    ready: markReady,
    error: (fatal) => errors.push(fatal),
  });
  return { changes, errors, ready, disposable, fire: {
    create: (path: string) => mock.listeners.create.forEach((fn) => fn({ fsPath: path })),
    save: (path: string) => mock.listeners.change.forEach((fn) => fn({ fsPath: path })),
    delete: (path: string) => mock.listeners.delete.forEach((fn) => fn({ fsPath: path })),
  } };
}

describe('follow watcher', () => {
  it('retries the baseline when a save arrives during startup', async () => {
    const root = await project();
    await writeFile(join(root, 'a.ts'), 'old\n');
    const watch = start(root);
    const writing = writeFile(join(root, 'late.ts'), 'created\n');
    watch.fire.create(join(root, 'late.ts'));
    await writing;
    await watch.ready;
    await settle();
    expect(mock.create).toHaveBeenCalledTimes(2);
    expect(watch.changes).toEqual([]);
    await writeFile(join(root, 'late.ts'), 'created\nlatest\n');
    watch.fire.save(join(root, 'late.ts'));
    await settle();
    expect(watch.changes).toEqual([{ file: 'late.ts', baseline: 'created\n', saved: 'created\nlatest\n', line: 1 }]);
  });

  it('reports the baseline snapshot and the first changed line', async () => {
    const root = await project();
    await writeFile(join(root, 'a.ts'), 'one\ntwo\n');
    const watch = start(root);
    await watch.ready;
    await writeFile(join(root, 'a.ts'), 'one\nTWO\n');
    watch.fire.save(join(root, 'a.ts'));
    await settle();
    expect(watch.changes).toEqual([{ file: 'a.ts', baseline: 'one\ntwo\n', saved: 'one\nTWO\n', line: 1 }]);
  });

  it('drops duplicate saves and reports removal only for known files', async () => {
    const root = await project();
    await writeFile(join(root, 'a.ts'), 'a\n');
    const watch = start(root);
    await watch.ready;
    await writeFile(join(root, 'a.ts'), 'b\n');
    watch.fire.save(join(root, 'a.ts'));
    watch.fire.save(join(root, 'a.ts'));
    await settle();
    expect(watch.changes).toHaveLength(1);
    watch.fire.delete(join(root, 'unknown.ts'));
    await settle();
    expect(watch.changes).toHaveLength(1);
    watch.fire.delete(join(root, 'a.ts'));
    await settle();
    expect(watch.changes[1]).toEqual({ file: 'a.ts', baseline: 'a\n', saved: undefined, line: 0 });
  });

  it('distinguishes a new empty file from an empty file present at open', async () => {
    const root = await project();
    await writeFile(join(root, 'existing.ts'), '');
    const watch = start(root);
    await watch.ready;
    await writeFile(join(root, 'born.ts'), '');
    watch.fire.create(join(root, 'born.ts'));
    await settle();
    expect(watch.changes).toEqual([{ file: 'born.ts', baseline: undefined, saved: '', line: 0 }]);
  });

  it('ignores secrets, excluded folders, binaries and oversized files', async () => {
    const root = await project();
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'x.ts'), 'x\n');
    await writeFile(join(root, '.env'), 'SECRET=1\n');
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, 'big.ts'), Buffer.alloc(1024 * 1024 + 1, 0x61));
    const watch = start(root);
    await watch.ready;
    for (const file of ['node_modules/x.ts', '.env', 'logo.png', 'big.ts']) watch.fire.save(join(root, file));
    await settle();
    expect(watch.changes).toEqual([]);
  });

  it('reports failed reads separately from deletions and stops when the root disappears', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    await writeFile(file, 'text\n');
    const watch = start(root);
    await watch.ready;
    await writeFile(file, Buffer.from([0, 1, 2]));
    watch.fire.save(file);
    await vi.waitFor(() => expect(watch.errors).toEqual([false]));
    expect(watch.changes).toEqual([]);
    watch.fire.delete(file);
    watch.fire.delete(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    expect(watch.changes[0]).toEqual({ file: 'a.ts', baseline: 'text\n', saved: undefined, line: 0 });
    watch.fire.delete(root);
    expect(watch.errors).toEqual([false, true]);
    expect(mock.dispose).toHaveBeenCalledTimes(2);
  });

  it('stays silent after dispose', async () => {
    const root = await project();
    await writeFile(join(root, 'a.ts'), 'a\n');
    const watch = start(root);
    await watch.ready;
    watch.disposable.dispose();
    await writeFile(join(root, 'a.ts'), 'b\n');
    watch.fire.save(join(root, 'a.ts'));
    await settle();
    expect(watch.changes).toEqual([]);
    expect(mock.dispose).toHaveBeenCalled();
  });
});
