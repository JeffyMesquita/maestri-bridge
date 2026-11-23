import { lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { gitIgnored } from './follow-excludes.ts';
import { followLineDelta, followRootError, isFollowFileAllowed, pinFollowRoot, readFollowFile } from './follow-file.ts';
import type { FollowRoot } from './follow-file.ts';


export interface FollowChange {
  file: string;
  baseline: string | undefined;
  saved: string | undefined;
  line: number;
}

export type FollowWatchError =
  | 'rootUnavailable'
  | 'rootChanged'
  | 'snapshotFailed'
  | 'readFailed'
  | 'snapshotLimited';

export interface FollowWatchHandlers {
  change: (change: FollowChange) => void;
  ready: () => void;
  activity: (active: boolean) => void;
  invalidate: () => void;
  error: (fatal: boolean, reason: FollowWatchError) => void;
}

const BASELINE_BYTE_LIMIT = 16 * 1024 * 1024;
const LATEST_BYTE_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 2000;
const BURST_MS = 90;
const GIT_BATCH = 500;
const DISCOVERY_LIMIT = 20001;
const META_LIMIT = 4000;

interface Queued {
  kind: 'read' | 'delete';
  seq: number;
  time: number;
  born: boolean;
  probe?: string;
}

export function watchFollowFiles(root: vscode.Uri, handlers: FollowWatchHandlers): vscode.Disposable {
  const rootPath = root.fsPath;
  const baseline = new Map<string, string>();
  const tracked = new Map<string, string>();
  const created = new Set<string>();
  const present = new Set<string>();
  const queued = new Map<string, Queued>();
  const known = new Set<string>();
  const lastSeq = new Map<string, number>();
  const subscriptions: vscode.Disposable[] = [];
  const warned = new Set<FollowWatchError>();
  let authority: FollowRoot | undefined;
  let baselineBytes = 0;
  let trackedBytes = 0;
  let seq = 0;
  let timer: NodeJS.Timeout | undefined;
  let ready = false;
  let scanningChanged = false;
  let disposed = false;
  let textPartial = false;
  let namesComplete = true;
  let flushing = false;
  let rulesVersion = 0;
  let refreshedRules = 0;
  let repositorySeen = false;
  let active = false;
  let quietUntil = 0;
  const inflight = new Map<string, Queued>();

  const announce = (next: boolean): void => {
    if (disposed || active === next) return;
    active = next;
    handlers.activity(next);
  };

  const invalidate = (): void => {
    if (disposed) return;
    announce(true);
    handlers.invalidate();
  };

  const warn = (reason: FollowWatchError): void => {
    if (disposed || warned.has(reason)) return;
    warned.add(reason);
    handlers.error(false, reason);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
    baseline.clear();
    tracked.clear();
    queued.clear();
    lastSeq.clear();
    known.clear();
    created.clear();
    present.clear();
    inflight.clear();
  };

  const fail = (reason: FollowWatchError): void => {
    if (disposed) return;
    dispose();
    handlers.error(true, reason);
  };

  const verifyRoot = async (pinned: FollowRoot): Promise<boolean> => {
    if (disposed) return false;
    const error = await followRootError(rootPath, pinned);
    if (error) fail(error);
    return !disposed;
  };

  const forgetLatest = (file: string): void => {
    const text = tracked.get(file);
    if (text === undefined) return;
    trackedBytes -= Buffer.byteLength(text);
    tracked.delete(file);
  };

  const remember = (file: string, text: string): void => {
    const size = Buffer.byteLength(text);
    forgetLatest(file);
    for (const oldest of tracked.keys()) {
      if (tracked.size < FILE_LIMIT && trackedBytes + size <= LATEST_BYTE_LIMIT) break;
      forgetLatest(oldest);
    }
    present.add(file);
    tracked.set(file, text);
    trackedBytes += size;
  };

  const trimNames = (): void => {
    if (known.size <= META_LIMIT) return;
    namesComplete = false;
    for (const oldest of known) {
      if (known.size <= META_LIMIT) break;
      known.delete(oldest);
      queued.delete(oldest);
      lastSeq.delete(oldest);
      created.delete(oldest);
      present.delete(oldest);
    }
    if (ready) warn('snapshotLimited');
  };

  const logical = (uri: vscode.Uri): string | undefined => {
    const absolute = uri.fsPath;
    if (!absolute) return undefined;
    for (const base of [authority?.path ?? rootPath, rootPath]) {
      const within = relative(base, absolute);
      if (within === '' || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) continue;
      return within.split(sep).join('/');
    }
    return undefined;
  };

  const ignoredSet = async (pinned: FollowRoot, files: string[]): Promise<Set<string> | undefined> => {
    const ignored = new Set<string>();
    for (let index = 0; index < files.length && !disposed; index += GIT_BATCH) {
      const paths = files.slice(index, index + GIT_BATCH).map((file) => join(pinned.path, file));
      const result = await gitIgnored(pinned.path, paths);
      if (result.kind === 'known') {
        repositorySeen = true;
        for (const path of result.paths) ignored.add(normalize(path));
      } else if (result.kind === 'unavailable' || repositorySeen) {
        textPartial = true;
        if (ready) warn('snapshotLimited');
        return undefined;
      }
    }
    return ignored;
  };

  const included = async (file: string): Promise<boolean> => {
    const pattern = file.replace(/[?*\[\]{}]/g, (character) => '[' + character + ']');
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, pattern), undefined, 1);
    return found.some((uri) => logical(uri) === file);
  };

  const probe = async (pinned: FollowRoot, folder: string, names: Set<string>, version: number, entry: Queued): Promise<void> => {
    if (!(await verifyRoot(pinned))) return;
    if (disposed || rulesVersion !== version) return;
    const base = vscode.Uri.file(join(pinned.path, folder));
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(base, '**/*'), undefined, DISCOVERY_LIMIT + 1);
    if (!(await verifyRoot(pinned))) return;
    if (disposed || rulesVersion !== version) return;
    if (found.length > DISCOVERY_LIMIT) {
      textPartial = true;
      warn('snapshotLimited');
    }
    let signature: string;
    try { signature = `${found.length}|${(await lstat(join(pinned.path, folder))).mtimeMs}`; } catch { return; }
    if (disposed || lastSeq.get(folder) !== entry.seq) return;
    for (const uri of found.slice(0, DISCOVERY_LIMIT)) {
      if (disposed || rulesVersion !== version) return;
      const file = logical(uri);
      if (file === undefined || !isFollowFileAllowed(file)) continue;
      if (names.has(file) || baseline.has(file) || tracked.has(file) || present.has(file) || queued.has(file)) continue;
      enqueue(uri, 'read', true);
    }
    if (disposed || lastSeq.get(folder) !== entry.seq) return;
    if (entry.probe === signature) return;
    queued.set(folder, { kind: 'read', seq: ++seq, time: Date.now(), born: true, probe: signature });
    lastSeq.set(folder, seq);
    quietUntil = performance.now() + BURST_MS;
    announce(true);
    trimNames();
  };

  const refreshIgnored = async (pinned: FollowRoot, version: number): Promise<void> => {
    const candidates = [...new Set([...baseline.keys(), ...tracked.keys(), ...present])];
    const ignored = await ignoredSet(pinned, candidates);
    for (const file of candidates) {
      if (disposed || rulesVersion !== version) return;
      const excluded = ignored?.has(join(pinned.path, file)) || !(await included(file));
      if (disposed || rulesVersion !== version) return;
      if (!excluded) continue;
      forgetLatest(file);
      present.delete(file);
      const initial = baseline.get(file);
      if (initial !== undefined) baselineBytes -= Buffer.byteLength(initial);
      baseline.delete(file);
    }
  };

  const flush = async (): Promise<void> => {
    timer = undefined;
    const pinned = authority;
    if (disposed || flushing || pinned === undefined) return;
    flushing = true;
    const batch = [...queued.entries()];
    queued.clear();
    const version = rulesVersion;
    const rulesCurrent = (): boolean => !disposed && rulesVersion === version;
    let processed = 0;
    try {
      if (!(await verifyRoot(pinned)) || !rulesCurrent()) return;
      if (refreshedRules !== version) {
        await refreshIgnored(pinned, version);
        if (!rulesCurrent()) return;
        refreshedRules = version;
      }
      const folders = new Map<string, Queued>();
      const names = new Set(batch.map(([file]) => file));
      for (const [file, event] of batch) {
        if (!rulesCurrent()) return;
        if (event.kind !== 'read') continue;
        try {
          const info = await lstat(join(pinned.path, file));
          event.time = info.mtimeMs;
          if (event.born && info.isDirectory()) folders.set(file, event);
        } catch {}
      }
      if (!rulesCurrent()) return;
      batch.sort((a, b) => a[1].time - b[1].time || a[1].seq - b[1].seq);
      const ignored = await ignoredSet(pinned, batch.map(([file]) => file));
      if (ignored === undefined || !rulesCurrent()) return;
      for (const [folder, entry] of folders) {
        if (ignored.has(join(pinned.path, folder))) continue;
        inflight.set(folder, entry);
        try { await probe(pinned, folder, names, version, entry); } finally { inflight.delete(folder); }
        if (!rulesCurrent()) return;
      }
      for (; processed < batch.length && rulesCurrent(); processed++) {
        const [file, event] = batch[processed]!;
        if (folders.has(file)) continue;
        if (lastSeq.get(file) !== event.seq || ignored.has(join(pinned.path, file))) continue;
        const previous = tracked.get(file);
        const initial = baseline.get(file);
        const isNew = created.has(file);
        const before = isNew ? undefined : initial ?? previous;
        if (event.kind === 'delete') {
          if (!(await verifyRoot(pinned)) || !rulesCurrent()) break;
          if (lastSeq.get(file) !== event.seq || !present.delete(file)) continue;
          forgetLatest(file);
          if (before !== undefined || isNew) handlers.change({ file, baseline: before, saved: undefined, line: 0 });
          continue;
        }
        const matching = await included(file);
        if (!rulesCurrent()) break;
        if (!matching) continue;
        if (!(await verifyRoot(pinned)) || !rulesCurrent()) break;
        if (lastSeq.get(file) !== event.seq) continue;
        const text = await readFollowFile(pinned, file);
        if (!(await verifyRoot(pinned)) || !rulesCurrent()) break;
        if (lastSeq.get(file) !== event.seq) continue;
        if (text === undefined) {
          if (previous !== undefined) warn('readFailed');
          continue;
        }
        if (text === previous) continue;
        remember(file, text);
        if (before !== undefined || isNew) {
          handlers.change({ file, baseline: before, saved: text, line: followLineDelta(previous ?? initial, text) });
        }
      }
    } catch {
      if (!disposed) warn('readFailed');
    } finally {
      flushing = false;
      for (const [index, [file, event]] of batch.entries()) {
        if (lastSeq.get(file) !== event.seq) continue;
        if (!disposed && rulesVersion !== version && index >= processed) queued.set(file, event);
        else lastSeq.delete(file);
      }
      if (queued.size > 0 || rulesVersion !== version) schedule();
      else if (timer === undefined) announce(false);
    }
  };

  const schedule = (): void => {
    if (disposed || flushing) return;
    if (timer !== undefined) clearTimeout(timer);
    const handle = setTimeout(() => {
      if (timer !== handle) return;
      void flush();
    }, Math.max(0, quietUntil - performance.now()));
    timer = handle;
  };

  const enqueue = (uri: vscode.Uri, kind: 'read' | 'delete', born = false): void => {
    if (disposed) return;
    const file = logical(uri);
    if (file === undefined || !isFollowFileAllowed(file)) return;
    if (!ready) {
      scanningChanged = true;
      return;
    }
    if (basename(file) === '.gitignore') { rulesVersion++; invalidate(); }
    const held = inflight.get(file);
    if (kind === 'read' && held !== undefined && queued.get(file)?.kind !== 'delete') {
      known.add(file);
      queued.set(file, { kind: 'read', seq: ++seq, time: Date.now(), born: true, probe: held.probe });
      lastSeq.set(file, seq);
      trimNames();
      quietUntil = performance.now() + BURST_MS;
      announce(true);
      schedule();
      return;
    }
    const wasKnown = known.delete(file) || baseline.has(file) || tracked.has(file);
    if (born && !wasKnown && namesComplete) created.add(file);
    known.add(file);
    queued.set(file, { kind, seq: ++seq, time: Date.now(), born });
    lastSeq.set(file, seq);
    trimNames();
    quietUntil = performance.now() + BURST_MS;
    announce(true);
    schedule();
  };

  const snapshot = async (pinned: FollowRoot): Promise<void> => {
    const eligible: string[] = [];
    const listed = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), undefined, DISCOVERY_LIMIT + 1);
    if (listed.length > DISCOVERY_LIMIT) namesComplete = false;
    for (const uri of listed) {
      if (disposed || scanningChanged) return;
      const file = logical(uri);
      if (file === undefined || !isFollowFileAllowed(file) || known.has(file)) continue;
      known.add(file);
      eligible.push(file);
    }
    const ignored = await ignoredSet(pinned, eligible);
    if (ignored !== undefined && await verifyRoot(pinned)) {
      for (const file of eligible) {
        if (disposed || scanningChanged) return;
        if (ignored.has(join(pinned.path, file))) continue;
        if (baseline.size >= FILE_LIMIT || baselineBytes >= BASELINE_BYTE_LIMIT) {
          textPartial = true;
          break;
        }
        const text = await readFollowFile(pinned, file);
        if (disposed || scanningChanged) return;
        const size = text === undefined ? 0 : Buffer.byteLength(text);
        if (text === undefined || baselineBytes + size > BASELINE_BYTE_LIMIT) {
          textPartial = true;
          continue;
        }
        baseline.set(file, text);
        baselineBytes += size;
        remember(file, text);
      }
    }
    trimNames();
  };

  const initialize = async (): Promise<void> => {
    const pinned = await pinFollowRoot(rootPath);
    if (pinned === undefined) {
      fail('rootUnavailable');
      return;
    }
    if (disposed) return;
    authority = pinned;
    for (let attempt = 0; attempt < 3 && !disposed; attempt++) {
      scanningChanged = false;
      baseline.clear();
      tracked.clear();
      known.clear();
      created.clear();
      present.clear();
      baselineBytes = 0;
      trackedBytes = 0;
      namesComplete = true;
      textPartial = false;
      try {
        await snapshot(pinned);
      } catch {
        if (!scanningChanged) {
          fail('snapshotFailed');
          return;
        }
      }
      if (!(await verifyRoot(pinned))) return;
      if (scanningChanged) continue;
      ready = true;
      refreshedRules = rulesVersion;
      if (textPartial || !namesComplete) warn('snapshotLimited');
      handlers.ready();
      return;
    }
    fail('snapshotFailed');
  };

  try {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    subscriptions.push(watcher, watcher.onDidCreate((uri) => enqueue(uri, 'read', true)),
      watcher.onDidChange((uri) => enqueue(uri, 'read')), watcher.onDidDelete((uri) => enqueue(uri, 'delete')));
    const onConfig = vscode.workspace.onDidChangeConfiguration;
    if (typeof onConfig === 'function') {
      subscriptions.push(onConfig((event) => {
        if (!event.affectsConfiguration('files.exclude', root)) return;
        if (ready) {
          rulesVersion++;
          namesComplete = false;
          invalidate();
          quietUntil = performance.now() + BURST_MS;
          schedule();
        } else {
          scanningChanged = true;
        }
      }));
    }
    const parent = dirname(rootPath);
    if (relative(parent, rootPath) !== '') {
      const parentWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(parent, '*'), true, true);
      subscriptions.push(parentWatcher, parentWatcher.onDidDelete((uri) => {
        if (relative(rootPath, uri.fsPath) === '') fail('rootUnavailable');
      }));
    }
    void initialize().catch(() => fail('snapshotFailed'));
  } catch {
    fail('rootUnavailable');
  }
  return { dispose };
}
