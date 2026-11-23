import { mkdtemp, mkdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchFollowFiles, type FollowChange } from '../src/follow-watch.ts';

const mock = vi.hoisted(() => {
  const listeners: Record<'create' | 'change' | 'delete', ((uri: unknown) => void)[]> = {
    create: [], change: [], delete: [],
  };
  return {
    listeners,
    excluded: [] as string[],
    ignored: [] as string[],
    gitFails: false,
    gitQueries: [] as string[][],
    configuration: [] as (() => void)[],
    dispose: vi.fn(),
    findFiles: vi.fn(async (pattern: { base: { fsPath: string }; pattern: string }, _exclude?: unknown, maxResults?: number) => {
      const { readdir } = await import('node:fs/promises');
      const out: { fsPath: string }[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = dir + '/' + entry.name;
          if (mock.excluded.includes(relative(pattern.base.fsPath, full).split(sep).join('/'))) continue;
          if (entry.isDirectory()) await walk(full);
          else if (pattern.pattern === '**/*' || relative(pattern.base.fsPath, full).split(sep).join('/') === pattern.pattern) out.push({ fsPath: full });
        }
      };
      await walk(pattern.base.fsPath);
      return out.sort((a, b) => a.fsPath.localeCompare(b.fsPath)).slice(0, maxResults);
    }),
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
  Uri: { file: (path: string) => ({ fsPath: path }) },
  workspace: {
    createFileSystemWatcher: mock.create, findFiles: mock.findFiles,
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration: () => boolean }) => void) => {
      mock.configuration.push(() => listener({ affectsConfiguration: () => true }));
      return { dispose: vi.fn() };
    },
  },
  extensions: {
    getExtension: () => ({
      activate: async () => undefined,
      exports: {
        getAPI: () => ({
          getRepository: () => null,
          openRepository: async () => ({
            checkIgnore: async (paths: string[]) => {
              mock.gitQueries.push(paths);
              if (mock.gitFails) throw new Error('ignore query temporarily unavailable');
              return new Set(paths.filter((value) => /[\\/]generated[\\/]/.test(value) || mock.ignored.some((suffix) => value.endsWith(suffix))));
            },
          }),
        }),
      },
    }),
  },
}));

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
beforeEach(() => {
  vi.clearAllMocks();
  mock.listeners.create.length = 0;
  mock.listeners.change.length = 0;
  mock.listeners.delete.length = 0;
  mock.excluded.length = 0;
  mock.ignored.length = 0;
  mock.gitFails = false;
  mock.gitQueries.length = 0;
  mock.configuration.length = 0;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

async function project(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'maestri-watch-'));
  temporary.push(parent);
  const root = join(parent, 'project');
  await mkdir(root);
  return root;
}

function start(root: string) {
  const changes: FollowChange[] = [];
  const activity: boolean[] = [];
  const invalidations = { count: 0 };
  const errors: boolean[] = [];
  const reasons: string[] = [];
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const disposable = watchFollowFiles({ fsPath: root } as never, {
    change: (change) => changes.push(change),
    ready: markReady,
    activity: (active) => activity.push(active),
    invalidate: () => { invalidations.count += 1; },
    error: (fatal, reason) => { errors.push(fatal); reasons.push(reason); },
  });
  return { changes, activity, invalidations, errors, reasons, ready, disposable, fire: {
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
    expect(watch.reasons).toEqual(['readFailed', 'rootUnavailable']);
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

describe('follow watcher bounds and canonical roots', () => {
  it('drops history when native excludes change and does not invent an empty baseline on re-entry', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    await writeFile(file, 'initial');
    const watch = start(root);
    await watch.ready;
    mock.excluded.push('a.ts');
    mock.configuration.forEach((listener) => listener());
    await settle();
    await writeFile(file, 'hidden'); watch.fire.save(file);
    await settle();
    expect(watch.changes).toEqual([]);
    mock.excluded.length = 0;
    await writeFile(file, 'reference'); watch.fire.save(file);
    await settle();
    expect(watch.changes).toEqual([]);
    await writeFile(file, 'latest'); watch.fire.save(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    expect(watch.changes[0]).toMatchObject({ baseline: 'reference', saved: 'latest' });
    watch.disposable.dispose();
  });

  it('refreshes Git ignores after a saved ignore rule and suppresses subsequent saves', async () => {
    const root = await project();
    const file = join(root, 'a.ts'); const rules = join(root, '.gitignore');
    await writeFile(file, 'initial'); await writeFile(rules, '');
    const watch = start(root);
    await watch.ready;
    mock.ignored.push('a.ts');
    await writeFile(rules, 'a.ts'); watch.fire.save(rules);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    await writeFile(file, 'ignored'); watch.fire.save(file);
    await settle();
    expect(watch.changes.map((change) => change.file)).toEqual(['.gitignore']);
    watch.disposable.dispose();
  });

  it('drops an old read when deletion arrives during its native exclusion query', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    await writeFile(file, 'old');
    const watch = start(root);
    await watch.ready;
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    await writeFile(file, 'new');
    watch.fire.save(file);
    await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2));
    watch.fire.delete(file);
    release([{ fsPath: file }]);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    expect(watch.changes).toEqual([{ file: 'a.ts', baseline: 'old', saved: undefined, line: 0 }]);
    watch.disposable.dispose();
  });

  it('fails visibly rather than declaring an unstable third snapshot ready', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    await writeFile(file, 'old');
    const original = mock.findFiles.getMockImplementation()!;
    mock.findFiles.mockImplementation(async (...args) => {
      mock.listeners.change.forEach((listener) => listener({ fsPath: file }));
      return original(...args);
    });
    const watch = start(root);
    try {
      await vi.waitFor(() => expect(watch.reasons).toEqual(['snapshotFailed']));
      expect(watch.errors).toEqual([true]);
      expect(mock.findFiles).toHaveBeenCalledTimes(3);
    } finally {
      mock.findFiles.mockImplementation(original);
      watch.disposable.dispose();
    }
  });

  it('reports a changed canonical root instead of reading the replacement', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'maestri-retarget-')); temporary.push(parent);
    const first = join(parent, 'first'); const second = join(parent, 'second'); const link = join(parent, 'link');
    await mkdir(first); await mkdir(second);
    await writeFile(join(first, 'a.ts'), 'first'); await writeFile(join(second, 'a.ts'), 'second');
    await symlink(first, link, process.platform === 'win32' ? 'junction' : 'dir');
    const watch = start(link);
    await watch.ready;
    await rm(link, { recursive: true });
    await symlink(second, link, process.platform === 'win32' ? 'junction' : 'dir');
    watch.fire.save(join(link, 'a.ts'));
    await vi.waitFor(() => expect(watch.reasons).toEqual(['rootChanged']));
    expect(watch.errors).toEqual([true]);
    expect(watch.changes).toEqual([]);
    watch.disposable.dispose();
  });

  it('degrades explicitly during a burst larger than the metadata budget', async () => {
    const root = await project();
    const watch = start(root);
    await watch.ready;
    for (let index = 0; index < 5000; index++) watch.fire.create(join(root, `new${index}.ts`));
    expect(watch.reasons).toEqual(['snapshotLimited']);
    expect(watch.errors).toEqual([false]);
    watch.disposable.dispose();
    expect(watch.changes).toEqual([]);
  });

  it('keeps the latest save last when native events arrive in filename order', async () => {
    const root = await project();
    for (let index = 0; index < 30; index++) await writeFile(join(root, `b${index}.ts`), 'old');
    const watch = start(root);
    await watch.ready;
    for (let index = 0; index < 30; index++) {
      const path = join(root, `b${index}.ts`);
      await writeFile(path, 'new');
      await utimes(path, new Date(1700000000000 + index * 100), new Date(1700000000000 + index * 100));
    }
    for (const file of Array.from({ length: 30 }, (_, index) => `b${index}.ts`).sort()) watch.fire.save(join(root, file));
    await vi.waitFor(() => expect(watch.changes).toHaveLength(30));
    expect(watch.changes.at(-1)?.file).toBe('b29.ts');
    watch.disposable.dispose();
  });

  it('queries native exclusions relative to the chosen root for nested saves', async () => {
    const root = await project();
    await mkdir(join(root, 'nested'));
    const file = join(root, 'nested', 'a.ts');
    await writeFile(file, 'old');
    const watch = start(root);
    await watch.ready;
    mock.findFiles.mockClear();
    await writeFile(file, 'new');
    watch.fire.save(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    expect(mock.findFiles.mock.calls[0]?.[0]).toMatchObject({ base: { fsPath: root }, pattern: 'nested/a.ts' });
    watch.disposable.dispose();
  });

  it('reveals the latest save while keeping the original baseline', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    await writeFile(file, 'a\nb\nc');
    const watch = start(root);
    await watch.ready;
    await writeFile(file, 'A\nb\nc'); watch.fire.save(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    await writeFile(file, 'A\nb\nC'); watch.fire.save(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(2));
    expect(watch.changes[1]).toMatchObject({ baseline: 'a\nb\nc', line: 2 });
    watch.disposable.dispose();
  });

  const readyWithin = async (watch: ReturnType<typeof start>, ms: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
    const result = await Promise.race([watch.ready.then(() => true), timeout]);
    if (timer) clearTimeout(timer);
    return result;
  };

  const makeFiles = async (dir: string, prefix: string, count: number, content: string | Buffer): Promise<void> => {
    const chunks: Promise<void>[] = [];
    for (let index = 0; index < count; index += 1) chunks.push(writeFile(join(dir, `${prefix}${index}.ts`), content));
    await Promise.all(chunks);
  };

  it('accepts a symlinked root and canonicalizes event paths', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'maestri-watch-')); temporary.push(parent);
    const real = join(parent, 'real'); const link = join(parent, 'link');
    await mkdir(real); await writeFile(join(real, 'a.ts'), 'one\n');
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    const physical = await realpath(real);
    const watch = start(link);
    expect(await readyWithin(watch, 3000)).toBe(true);
    expect(watch.errors).toEqual([]);
    await writeFile(join(physical, 'a.ts'), 'two\n');
    watch.fire.save(join(physical, 'a.ts'));
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1), { timeout: 3000 });
    expect(watch.changes[0]).toMatchObject({ file: 'a.ts', baseline: 'one\n', saved: 'two\n' });
    await writeFile(join(link, 'a.ts'), 'three\n');
    watch.fire.save(join(link, 'a.ts'));
    await vi.waitFor(() => expect(watch.changes).toHaveLength(2), { timeout: 3000 });
    expect(watch.changes[1]).toMatchObject({ file: 'a.ts', baseline: 'one\n', saved: 'three\n' });
  });

  it('survives a root with more than 2000 files and still reports changes', async () => {
    const root = await project();
    await makeFiles(root, 'f', 2001, 'x\n');
    const watch = start(root);
    expect(await readyWithin(watch, 20000)).toBe(true);
    expect(watch.errors).not.toContain(true);
    await writeFile(join(root, 'f0.ts'), 'y\n');
    watch.fire.save(join(root, 'f0.ts'));
    await vi.waitFor(() => expect(watch.changes.length).toBeGreaterThan(0), { timeout: 5000 });
  }, 20000);

  it('does not spend the file budget on .gitignore exclusions', async () => {
    const root = await project();
    await writeFile(join(root, '.gitignore'), 'generated/\n');
    await mkdir(join(root, 'generated'));
    await makeFiles(join(root, 'generated'), 'g', 2100, 'x\n');
    await writeFile(join(root, 'keep.ts'), 'one\n');
    const watch = start(root);
    expect(await readyWithin(watch, 20000)).toBe(true);
    expect(watch.errors).not.toContain(true);
    expect(watch.reasons).not.toContain('snapshotLimited');
    await writeFile(join(root, 'keep.ts'), 'two\n');
    watch.fire.save(join(root, 'keep.ts'));
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1), { timeout: 5000 });
    expect(watch.changes[0]).toMatchObject({ file: 'keep.ts', saved: 'two\n' });
  });

  it('keeps running after the aggregate byte limit is exceeded', async () => {
    const root = await project();
    await makeFiles(root, 'big', 17, Buffer.alloc(1024 * 1024, 0x61));
    await writeFile(join(root, 'small.ts'), 'a\n');
    const watch = start(root);
    expect(await readyWithin(watch, 20000)).toBe(true);
    expect(watch.errors).not.toContain(true);
    await writeFile(join(root, 'small.ts'), 'b\n');
    watch.fire.save(join(root, 'small.ts'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(watch.changes).toHaveLength(0);
    await writeFile(join(root, 'small.ts'), 'c\n');
    watch.fire.save(join(root, 'small.ts'));
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1), { timeout: 5000 });
    expect(watch.changes[0]).toMatchObject({ file: 'small.ts', baseline: 'b\n', saved: 'c\n', line: 0 });
  });
  it('excludes git-ignored files before the file budget', async () => {
    const root = await project();
    await mkdir(join(root, 'generated'));
    await makeFiles(join(root, 'generated'), 'g', 2100, 'x\n');
    await writeFile(join(root, 'a.ts'), 'one\n');
    const watch = start(root);
    expect(await readyWithin(watch, 30000)).toBe(true);
    expect(watch.reasons).not.toContain('snapshotLimited');
    await writeFile(join(root, 'a.ts'), 'one\ntwo\n');
    watch.fire.save(join(root, 'a.ts'));
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1), { timeout: 5000 });
    expect(watch.changes[0]).toMatchObject({ file: 'a.ts', baseline: 'one\n', saved: 'one\ntwo\n', line: 1 });
  });

  it('treats the first save of an omitted pre-existing file as reference only', async () => {
    const root = await project();
    await makeFiles(root, 'big', 24, Buffer.alloc(700 * 1024, 0x61));
    const watch = start(root);
    expect(await readyWithin(watch, 30000)).toBe(true);
    expect(watch.reasons).toContain('snapshotLimited');
    const target = join(root, 'big9.ts');
    await writeFile(target, Buffer.alloc(700 * 1024, 0x62));
    watch.fire.save(target);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(watch.changes).toHaveLength(0);
    await writeFile(target, Buffer.alloc(700 * 1024, 0x63));
    watch.fire.save(target);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1), { timeout: 5000 });
    expect(watch.changes[0]?.baseline).toBeDefined();
  });

  it('applies the newest event when a save and a delete share a burst', async () => {
    const root = await project();
    await writeFile(join(root, 'a.ts'), 'a\n');
    const watch = start(root);
    await watch.ready;
    await writeFile(join(root, 'a.ts'), 'b\n');
    watch.fire.save(join(root, 'a.ts'));
    watch.fire.delete(join(root, 'a.ts'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(watch.changes).toEqual([{ file: 'a.ts', baseline: 'a\n', saved: undefined, line: 0 }]);
  });
  it('fails fatally when the watched root disappears', async () => {
    const root = await project();
    const watch = start(root);
    await watch.ready;
    watch.fire.delete(root);
    expect(watch.errors).toEqual([true]);
    expect(watch.reasons).toEqual(['rootUnavailable']);
  });
});

describe('follow watcher policy and baseline invariants', () => {
  it('rejects a same-path replacement directory during an in-flight exclusion lookup', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    await writeFile(file, 'authorized text');
    const watch = start(root);
    await watch.ready;
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    await writeFile(file, 'authorized save');
    watch.fire.save(file);
    await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2));
    await rename(root, root + '-old');
    await mkdir(root);
    await writeFile(file, 'replacement text');
    release([{ fsPath: file }]);
    await settle();
    expect(watch.reasons).toEqual(['rootChanged']);
    expect(watch.changes).toEqual([]);
    watch.disposable.dispose();
  });

  it('invalidates an in-flight rule result and preserves a newer save already queued', async () => {
    const root = await project();
    const a = join(root, 'a.ts');
    const b = join(root, 'b.ts');
    await writeFile(a, 'first a');
    await writeFile(b, 'first b');
    const watch = start(root);
    await watch.ready;
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    await writeFile(a, 'excluded a');
    watch.fire.save(a);
    await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2));
    mock.excluded.push('a.ts');
    mock.configuration.forEach((listener) => listener());
    await writeFile(b, 'latest b');
    watch.fire.save(b);
    release([{ fsPath: a }]);
    await vi.waitFor(() => expect(watch.changes.some(({ file }) => file === 'b.ts')).toBe(true));
    expect(watch.changes.map(({ file }) => file)).toEqual(['b.ts']);
    watch.disposable.dispose();
  });

  it('keeps a known repository fail-closed until its ignore query recovers', async () => {
    const root = await project();
    const a = join(root, 'a.ts');
    await writeFile(a, 'first');
    const watch = start(root);
    await watch.ready;
    mock.gitFails = true;
    await writeFile(a, 'unverified');
    watch.fire.save(a);
    await settle();
    expect(watch.changes).toEqual([]);
    mock.gitFails = false;
    await writeFile(a, 'verified');
    watch.fire.save(a);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    expect(watch.changes[0]).toMatchObject({ baseline: 'first', saved: 'verified' });
    watch.disposable.dispose();
  });

  it('does not loop on the same rule generation after a native search error', async () => {
    const root = await project();
    await writeFile(join(root, 'a.ts'), 'initial');
    const watch = start(root);
    await watch.ready;
    mock.findFiles.mockRejectedValueOnce(new Error('native search failed'));
    mock.configuration.forEach((listener) => listener());
    await vi.waitFor(() => expect(watch.reasons).toEqual(['readFailed']));
    await settle();
    expect(mock.findFiles).toHaveBeenCalledTimes(2);
    await writeFile(join(root, 'a.ts'), 'last');
    watch.fire.save(join(root, 'a.ts'));
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    watch.disposable.dispose();
  });

  it('uses canonical paths in Git queries through a symlinked workspace', async () => {
    const root = await project();
    const path = await realpath(root);
    const link = root + '-link';
    await symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(root, 'a.ts'), 'first');
    const watch = start(link);
    await watch.ready;
    expect(mock.gitQueries).toEqual([[join(path, 'a.ts')]]);
    watch.disposable.dispose();
  });

  it('reports deletion and recreation with the captured baseline after latest-text eviction', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    await writeFile(file, 'original');
    const megabyte = Buffer.alloc(1024 * 1024, 0x61);
    await Promise.all(Array.from({ length: 15 }, (_, i) => writeFile(join(root, 'b' + i + '.ts'), megabyte)));
    const watch = start(root);
    await watch.ready;
    const enoughToEvict = join(root, 'z.ts');
    await writeFile(enoughToEvict, megabyte);
    watch.fire.create(enoughToEvict);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    await rm(file);
    watch.fire.delete(file);
    await settle();
    expect(watch.changes.map(({ file }) => file)).toEqual(['z.ts', 'a.ts']);
    expect(watch.changes[1]).toEqual({ file: 'a.ts', baseline: 'original', saved: undefined, line: 0 });
    watch.fire.delete(file);
    await settle();
    expect(watch.changes).toHaveLength(2);
    await writeFile(file, 'recreated');
    watch.fire.create(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(3));
    expect(watch.changes.at(-1)).toMatchObject({ baseline: 'original', saved: 'recreated' });
    watch.disposable.dispose();
  }, 15000);

  it('keeps an empty session baseline across saves, deletion and recreation of a new file', async () => {
    const root = await project();
    const file = join(root, 'new.ts');
    const watch = start(root);
    await watch.ready;
    await writeFile(file, 'first');
    watch.fire.create(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1));
    await writeFile(file, 'second');
    watch.fire.save(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(2));
    expect(watch.changes[1]).toMatchObject({ baseline: undefined, saved: 'second' });
    await rm(file);
    watch.fire.delete(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(3));
    await writeFile(file, 'third');
    watch.fire.create(file);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(4));
    expect(watch.changes[3]).toMatchObject({ baseline: undefined, saved: 'third' });
    watch.disposable.dispose();
  });

  it('reports new paths when discovery was complete but baseline text was partial', async () => {
    const root = await project();
    await writeFile(join(root, 'large.ts'), Buffer.alloc(1024 * 1024 + 1, 0x61));
    const watch = start(root);
    await watch.ready;
    expect(watch.reasons).toContain('snapshotLimited');
    const file = join(root, 'new.ts');
    await writeFile(file, 'first');
    watch.fire.create(file);
    await settle();
    expect(watch.changes).toEqual([{ file: 'new.ts', baseline: undefined, saved: 'first', line: 0 }]);
    watch.disposable.dispose();
  });
});

describe('follow watcher presentation bursts', () => {
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('opens once for a continuous burst and waits for 90ms of quiet after the last save', async () => {
    const root = await project();
    for (let index = 0; index < 4; index++) await writeFile(join(root, `s${index}.ts`), 'old');
    const watch = start(root);
    await watch.ready;
    for (let index = 0; index < 4; index++) {
      await writeFile(join(root, `s${index}.ts`), 'new');
      watch.fire.save(join(root, `s${index}.ts`));
      if (index < 3) await pause(20);
    }
    expect(watch.activity).toEqual([true]);
    expect(watch.changes).toEqual([]);
    await pause(40);
    expect(watch.activity).toEqual([true]);
    expect(watch.changes).toEqual([]);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(4), { timeout: 5000 });
    expect(watch.activity).toEqual([true, false]);
    watch.disposable.dispose();
  });

  it('keeps the presentation open when a save lands during a slow native lookup', async () => {
    const root = await project();
    const a = join(root, 'a.ts');
    const b = join(root, 'b.ts');
    await writeFile(a, 'one');
    await writeFile(b, 'one');
    const watch = start(root);
    await watch.ready;
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    await writeFile(a, 'two');
    watch.fire.save(a);
    expect(watch.activity).toEqual([true]);
    await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await writeFile(b, 'two');
    watch.fire.save(b);
    expect(watch.activity).toEqual([true]);
    release([{ fsPath: a }]);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(2), { timeout: 5000 });
    expect(watch.activity).toEqual([true, false]);
    watch.disposable.dispose();
  });

  it('does not release the presentation after dispose during an in-flight flush', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    await writeFile(file, 'one');
    const watch = start(root);
    await watch.ready;
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    await writeFile(file, 'two');
    watch.fire.save(file);
    await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2), { timeout: 3000 });
    watch.disposable.dispose();
    release([{ fsPath: file }]);
    await settle();
    expect(watch.activity).toEqual([true]);
    expect(watch.changes).toEqual([]);
  });
});

describe('follow watcher rule invalidation', () => {
  it('invalidates and signals collection for a configuration-only change', async () => {
    const root = await project();
    const watch = start(root);
    await watch.ready;
    mock.configuration.forEach((listener) => listener());
    expect(watch.invalidations.count).toBe(1);
    expect(watch.activity).toEqual([true]);
    await vi.waitFor(() => expect(watch.activity).toEqual([true, false]));
    watch.disposable.dispose();
  });

  it('invalidates a queued save when excludes change during a blocked refresh', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    await writeFile(file, 'one');
    const watch = start(root);
    await watch.ready;
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    await writeFile(file, 'two');
    watch.fire.save(file);
    await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2));
    mock.excluded.push('a.ts');
    mock.configuration.forEach((listener) => listener());
    expect(watch.invalidations.count).toBe(1);
    release([{ fsPath: file }]);
    await settle();
    expect(watch.changes).toEqual([]);
    await vi.waitFor(() => expect(watch.activity).toEqual([true, false]));
    watch.disposable.dispose();
  });

  it('keeps the burst open while a newly created folder is still filling across waves', async () => {
    const root = await project();
    const watch = start(root);
    await watch.ready;
    const burst = join(root, 'burst');
    await mkdir(burst);
    const write = async (index: number): Promise<void> => {
      const path = join(burst, `b${index}.mjs`);
      await writeFile(path, `burst ${index}\n`);
      const stamp = new Date(1700000000000 + index * 100);
      await utimes(path, stamp, stamp);
    };
    for (let index = 0; index < 15; index += 1) await write(index);
    watch.fire.create(burst);
    watch.fire.create(join(burst, 'b0.mjs'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    for (let index = 15; index < 30; index += 1) await write(index);
    await vi.waitFor(() => expect(watch.changes.at(-1)?.file).toBe('burst/b29.mjs'), { timeout: 8000 });
    expect(watch.changes).toHaveLength(30);
    expect(new Set(watch.changes.map(({ file }) => file)).size).toBe(30);
    for (const change of watch.changes) {
      expect(change.baseline).toBeUndefined();
      const index = change.file.slice('burst/b'.length, -'.mjs'.length);
      expect(change.saved).toBe(`burst ${index}\n`);
    }
    await vi.waitFor(() => expect(watch.activity).toEqual([true, false]), { timeout: 8000 });
    for (let index = 1; index < 30; index += 1) watch.fire.create(join(burst, `b${index}.mjs`));
    await settle();
    expect(watch.changes).toHaveLength(30);
    expect(new Set(watch.changes.map(({ file }) => file)).size).toBe(30);
    watch.disposable.dispose();
  }, 25000);

  it('releases activity once two new folders probe stable', async () => {
    const root = await project();
    const watch = start(root);
    await watch.ready;
    const first = join(root, 'first');
    const second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, 'a.mjs'), 'first\n');
    await writeFile(join(second, 'b.mjs'), 'second\n');
    watch.fire.create(first);
    watch.fire.create(second);
    watch.fire.create(join(first, 'a.mjs'));
    watch.fire.create(join(second, 'b.mjs'));
    await vi.waitFor(() => expect(watch.changes).toHaveLength(2), { timeout: 8000 });
    expect(watch.changes.map(({ file }) => file).sort()).toEqual(['first/a.mjs', 'second/b.mjs']);
    await vi.waitFor(() => expect(watch.activity).toEqual([true, false]), { timeout: 8000 });
    watch.disposable.dispose();
  }, 20000);

  it('keeps a probing folder open when its own change event arrives in flight', async () => {
    const root = await project();
    const watch = start(root);
    await watch.ready;
    const dir = join(root, 'grow');
    await mkdir(dir);
    await writeFile(join(dir, 'a.mjs'), 'a\n');
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    watch.fire.create(dir);
    await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2), { timeout: 5000 });
    watch.fire.save(dir);
    release([{ fsPath: join(dir, 'a.mjs') }]);
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1), { timeout: 8000 });
    expect(watch.changes[0]?.file).toBe('grow/a.mjs');
    await vi.waitFor(() => expect(watch.activity).toEqual([true, false]), { timeout: 8000 });
    watch.disposable.dispose();
  }, 20000);

  it('lets a newer delete win over an in-flight folder probe', async () => {
    const root = await project();
    const watch = start(root);
    await watch.ready;
    const dir = join(root, 'gone');
    await mkdir(dir);
    await writeFile(join(dir, 'a.mjs'), 'a\n');
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    watch.fire.create(dir);
    await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2), { timeout: 5000 });
    watch.fire.delete(dir);
    release([{ fsPath: join(dir, 'a.mjs') }]);
    await settle();
    expect(watch.changes.filter(({ file }) => file.startsWith('gone/'))).toEqual([]);
    await vi.waitFor(() => expect(watch.activity).toEqual([true, false]), { timeout: 8000 });
    watch.disposable.dispose();
  }, 20000);

  it('does not inherit probe state after a delete precedes a folder read', async () => {
    const root = await project();
    const watch = start(root);
    await watch.ready;
    const dir = join(root, 'gone');
    await mkdir(dir);
    await writeFile(join(dir, 'a.mjs'), 'a\n');
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    watch.fire.create(dir);
    await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2), { timeout: 5000 });
    watch.fire.delete(dir);
    watch.fire.save(dir);
    release([{ fsPath: join(dir, 'a.mjs') }]);
    await settle();
    expect(watch.changes.filter(({ file }) => file.startsWith('gone/'))).toEqual([]);
    await vi.waitFor(() => expect(watch.activity).toEqual([true, false]), { timeout: 8000 });
    watch.disposable.dispose();
  }, 20000);

  it('releases activity after one stable probe of an empty new folder', async () => {
    const root = await project();
    const watch = start(root);
    await watch.ready;
    const empty = join(root, 'empty');
    await mkdir(empty);
    watch.fire.create(empty);
    await vi.waitFor(() => expect(watch.activity).toEqual([true, false]), { timeout: 5000 });
    expect(watch.changes).toEqual([]);
    watch.disposable.dispose();
  }, 15000);

  it('times the quiet window on a monotonic clock when the civil clock jumps back', async () => {
    const root = await project();
    const file = join(root, 'a.ts');
    const other = join(root, 'b.ts');
    await writeFile(file, 'one');
    await writeFile(other, 'one');
    const watch = start(root);
    await watch.ready;
    let release: (value: { fsPath: string }[]) => void = () => undefined;
    mock.findFiles.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      await writeFile(file, 'two');
      watch.fire.save(file);
      await vi.waitFor(() => expect(mock.findFiles).toHaveBeenCalledTimes(2));
      await writeFile(other, 'two');
      watch.fire.save(other);
      spy.mockReturnValue(1_700_000_000_000 - 30_000);
      release([{ fsPath: file }]);
      await vi.waitFor(() => expect(watch.changes.map(({ file: name }) => name)).toContain('b.ts'), { timeout: 3000 });
    } finally {
      spy.mockRestore();
      watch.disposable.dispose();
    }
  });

  it.skipIf(process.platform !== 'darwin')('watches a /var/tmp alias root through the real /private/var/tmp path', async () => {
    const root = await mkdtemp('/var/tmp/maestri-watch-');
    temporary.push(root);
    await writeFile(join(root, 'a.ts'), 'one\n');
    const physical = await realpath(root);
    expect(physical.startsWith('/private/var/tmp/')).toBe(true);
    const watch = start(root);
    await watch.ready;
    expect(watch.errors).toEqual([]);
    await writeFile(join(physical, 'a.ts'), 'two\n');
    watch.fire.save(join(physical, 'a.ts'));
    await vi.waitFor(() => expect(watch.changes).toHaveLength(1), { timeout: 15000 });
    expect(watch.changes[0]).toMatchObject({ file: 'a.ts', baseline: 'one\n', saved: 'two\n' });
    watch.disposable.dispose();
  }, 30000);
});
