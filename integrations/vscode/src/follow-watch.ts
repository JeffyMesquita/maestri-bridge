import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { followLineDelta, isFollowFileAllowed, isFollowPathIgnored, readFollowFile } from './follow-file.ts';

export interface FollowChange {
  file: string;
  baseline: string | undefined;
  saved: string | undefined;
  line: number;
}

export interface FollowWatchHandlers {
  change: (change: FollowChange) => void;
  ready: () => void;
  error: (fatal: boolean) => void;
}

const byteLimit = 16 * 1024 * 1024;
const fileLimit = 2000;

export function watchFollowFiles(root: vscode.Uri, handlers: FollowWatchHandlers): vscode.Disposable {
  const rootPath = root.fsPath;
  const baseline = new Map<string, string>();
  const saved = new Map<string, string>();
  const omitted = new Set<string>();
  const queued = new Map<string, 'read' | 'delete'>();
  const subscriptions: vscode.Disposable[] = [];
  let bytes = 0;
  let ready = false;
  let scanningChanged = false;
  let draining = false;
  let disposed = false;
  let physicalRoot = '';

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
    baseline.clear();
    saved.clear();
    omitted.clear();
    queued.clear();
  };

  const fail = (): void => {
    if (disposed) return;
    dispose();
    handlers.error(true);
  };

  const save = (file: string, text: string, previous: string | undefined): boolean => {
    const nextBytes = bytes - Buffer.byteLength(previous ?? '') + Buffer.byteLength(text);
    if (nextBytes > byteLimit || (previous === undefined && saved.size >= fileLimit)) return false;
    saved.set(file, text);
    bytes = nextBytes;
    return true;
  };

  const drain = async (): Promise<void> => {
    if (draining || disposed) return;
    draining = true;
    try {
      if (relative(physicalRoot, await realpath(rootPath)) !== '') {
        fail();
        return;
      }
      for (const [file, kind] of queued) {
        if (disposed) break;
        queued.delete(file);
        const previous = saved.get(file);
        if (kind === 'delete') {
          if (previous !== undefined) {
            saved.delete(file);
            bytes -= Buffer.byteLength(previous);
            handlers.change({ file, baseline: baseline.get(file), saved: undefined, line: 0 });
          }
          continue;
        }
        if (omitted.has(file)) continue;
        const text = await readFollowFile(physicalRoot, file);
        if (disposed) break;
        if (queued.has(file) || text === previous) continue;
        if (text === undefined || !save(file, text, previous)) {
          if (previous !== undefined || text !== undefined) handlers.error(false);
          continue;
        }
        handlers.change({ file, baseline: baseline.get(file), saved: text, line: followLineDelta(previous, text) });
      }
    } catch {
      fail();
    } finally {
      draining = false;
    }
  };

  const enqueue = (uri: vscode.Uri, kind: 'read' | 'delete'): void => {
    if (disposed) return;
    const path = relative(rootPath, uri.fsPath);
    const file = path.split(sep).join('/');
    if (isAbsolute(path) || !isFollowFileAllowed(file)) return;
    if (!ready) {
      scanningChanged = true;
      return;
    }
    queued.set(file, kind);
    if (kind === 'delete') {
      for (const child of saved.keys()) {
        if (child.startsWith(file + '/')) queued.set(child, kind);
      }
    }
    if (queued.size > fileLimit) fail();
    else void drain();
  };

  const scan = async (folder: string, depth: number): Promise<void> => {
    const path = join(physicalRoot, folder);
    if (!(await lstat(path)).isDirectory() || relative(path, await realpath(path)) !== '') return;
    if (depth > 12) throw new Error('Follow snapshot depth exceeded');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (disposed || scanningChanged) return;
      const file = folder ? folder + '/' + entry.name : entry.name;
      if (entry.isDirectory() && !isFollowPathIgnored(file) && isFollowFileAllowed(file)) {
        await scan(file, depth + 1);
      } else if (entry.isFile() && isFollowFileAllowed(file)) {
        if (baseline.size + omitted.size >= fileLimit) throw new Error('Follow snapshot file limit exceeded');
        const text = await readFollowFile(physicalRoot, file);
        if (disposed) return;
        if (text === undefined) omitted.add(file);
        else {
          if (!save(file, text, undefined)) throw new Error('Follow snapshot byte limit exceeded');
          baseline.set(file, text);
        }
      }
    }
  };

  const initialize = async (): Promise<void> => {
    physicalRoot = await realpath(rootPath);
    if (!(await lstat(rootPath)).isDirectory()) throw new Error('Follow requires a local directory');
    for (let attempt = 0; attempt < 3 && !disposed; attempt++) {
      scanningChanged = false;
      baseline.clear();
      saved.clear();
      omitted.clear();
      bytes = 0;
      try {
        await scan('', 0);
      } catch (error) {
        if (!scanningChanged) throw error;
      }
      if (disposed) return;
      if (!scanningChanged) {
        ready = true;
        handlers.ready();
        return;
      }
    }
    fail();
  };

  try {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    subscriptions.push(watcher, watcher.onDidCreate((uri) => enqueue(uri, 'read')),
      watcher.onDidChange((uri) => enqueue(uri, 'read')), watcher.onDidDelete((uri) => enqueue(uri, 'delete')));
    const parent = dirname(rootPath);
    if (relative(parent, rootPath) !== '') {
      const parentWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parent, '*'), true, true);
      subscriptions.push(parentWatcher, parentWatcher.onDidDelete((uri) => {
        if (relative(rootPath, uri.fsPath) === '') fail();
      }));
    }
    void initialize().catch(fail);
  } catch {
    fail();
  }
  return { dispose };
}
