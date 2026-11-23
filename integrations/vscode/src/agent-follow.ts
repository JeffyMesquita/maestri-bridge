import { isAbsolute, relative } from 'node:path';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { AgentMonitor } from './agent-monitor.ts';
import { FollowEditor } from './follow-editor.ts';
import { watchFollowFiles } from './follow-watch.ts';
import type { FollowChange, FollowWatchError } from './follow-watch.ts';
import { t } from './i18n/index.ts';
import type { ExtensionServices } from './services.ts';
import type { AgentTarget } from './target-memory.ts';

type FollowPhase = 'starting' | 'following' | 'paused';
const PENDING_LIMIT = 20000;

interface FollowSession {
  target: AgentTarget;
  phase: FollowPhase;
  pending: Map<string, number>;
  revision: number;
  epoch: number;
  collecting: boolean;
  activityRevision: number;
  latest?: FollowChange;
  root?: vscode.Uri;
  watcher?: vscode.Disposable;
  error?: boolean;
  errorReason?: FollowWatchError;
  limited?: boolean;
  opening?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class AgentFollow implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly editor = new FollowEditor();
  private readonly subscriptions: vscode.Disposable[];
  private session: FollowSession | undefined;
  private selectionTick = 0;
  private viewTick = 0;

  get summary(): { phase: FollowPhase; pendingCount: number; error?: boolean; errorReason?: FollowWatchError; limited?: boolean } | undefined {
    const session = this.session;
    return session && {
      phase: session.phase, pendingCount: session.pending.size, error: session.error,
      errorReason: session.errorReason, limited: session.limited,
    };
  }

  constructor(services: ExtensionServices, private readonly monitor: AgentMonitor) {
    this.subscriptions = [
      vscode.window.onDidChangeTextEditorSelection(({ kind }) => {
        if (kind !== vscode.TextEditorSelectionChangeKind.Keyboard && kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
        this.selectionTick++;
        const session = this.session;
        if (session === undefined) return;
        if (session.phase === 'following') {
          if (session.timer !== undefined) clearTimeout(session.timer);
          session.timer = undefined;
          session.phase = 'paused';
          this.editor.cancelPending();
          this.changes.fire();
        } else if (session.opening && this.selectionTick > this.viewTick) {
          this.editor.cancelPending();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(({ removed }) => {
        const root = this.session?.root;
        if (root && removed.some((folder) => folder.uri.toString() === root.toString())) this.stop();
      }),
      services.session.onDidChangeCredentials(() => this.stop()),
    ];
  }

  setChatTarget(target: AgentTarget | undefined): void {
    const current = this.session?.target;
    if (current && (target?.workspaceId !== current.workspaceId ||
      target?.floorId !== current.floorId || target?.terminalId !== current.terminalId)) {
      this.stop();
    }
  }

  async toggle(target: AgentTarget | undefined): Promise<void> {
    if (this.session) {
      this.stop();
      return;
    }
    if (!target || !vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(t('follow.unavailable'));
      return;
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
    if (folders.length === 0) {
      void vscode.window.showWarningMessage(t('follow.openFolder'));
      return;
    }

    const session: FollowSession = { target, phase: 'starting', pending: new Map(), revision: 0, epoch: 0, collecting: false, activityRevision: 0 };
    this.session = session;
    this.changes.fire();
    try {
      const workspace = this.monitor.workspaces.find(({ id }) => id === target.workspaceId);
      const mappedPath = target.floorId === undefined || target.floorId === 'ground'
        ? workspace?.workingDirectory
        : undefined;
      let mapped: typeof folders[number] | undefined;
      if (mappedPath && isAbsolute(mappedPath)) {
        let physical: string | undefined;
        try { physical = await realpath(mappedPath); } catch {}
        for (const candidate of folders) {
          if (relative(candidate.uri.fsPath, mappedPath) === '') { mapped = candidate; break; }
          if (physical === undefined) continue;
          try {
            if (relative(await realpath(candidate.uri.fsPath), physical) === '') { mapped = candidate; break; }
          } catch {}
        }
      }
      if (this.session !== session) return;
      const folder = mapped ?? (await vscode.window.showQuickPick(
        folders.map((item) => ({ label: item.name, description: item.uri.fsPath, folder: item })),
        { title: t('follow.chooseRoot') },
      ))?.folder;
      if (this.session !== session) return;
      if (!folder || !vscode.workspace.isTrusted ||
        !vscode.workspace.workspaceFolders?.some((item) => item.uri.toString() === folder.uri.toString())) {
        this.stop();
        return;
      }

      session.root = folder.uri;
      this.editor.begin();
      session.watcher = watchFollowFiles(folder.uri, {
        invalidate: () => {
          if (this.session !== session) return;
          session.epoch++;
          session.pending.clear();
          session.latest = undefined;
          if (session.timer !== undefined) clearTimeout(session.timer);
          session.timer = undefined;
          this.editor.cancelPending();
          this.changes.fire();
        },
        activity: (active) => {
          if (this.session !== session) return;
          session.collecting = active;
          if (active) {
            session.activityRevision++;
            if (session.timer !== undefined) clearTimeout(session.timer);
            session.timer = undefined;
            if (session.phase === 'following') this.editor.cancelPending();
          } else if (session.phase === 'following' && session.pending.size > 0) {
            this.schedule(session);
          }
        },
        change: (change) => {
          if (this.session !== session) return;
          session.pending.delete(change.file);
          session.pending.set(change.file, ++session.revision);
          session.latest = change;
          if (session.pending.size > PENDING_LIMIT) {
            const oldest = session.pending.keys().next().value;
            if (oldest !== undefined) session.pending.delete(oldest);
            this.reportError(session, false, 'snapshotLimited');
          }
          if (session.phase === 'paused') this.changes.fire();
          if (session.phase === 'following') this.schedule(session);
        },
        ready: () => {
          if (this.session !== session) return;
          session.phase = 'following';
          this.changes.fire();
          if (session.pending.size > 0) this.schedule(session);
        },
        error: (fatal, reason) => this.reportError(session, fatal, reason),
      });
    } catch {
      this.reportError(session, true, 'snapshotFailed');
    }
  }

  async viewPending(): Promise<void> {
    const session = this.session;
    if (session?.phase !== 'paused' || session.opening) return;
    const reviewed = [...session.pending];
    const change = session.latest;
    if (reviewed.length === 0 || !change) return;
    session.opening = true;
    const epoch = session.epoch;
    const tick = this.selectionTick;
    this.viewTick = tick;
    const current = (): boolean => this.session === session && session.phase === 'paused' &&
      session.epoch === epoch && this.selectionTick === tick;
    try {
      const shown = await this.editor.show(change, current);
      if (!current()) return;
      if (!shown) {
        this.reportError(session, false, 'readFailed');
        return;
      }
      this.acknowledge(session, reviewed);
      session.phase = 'following';
      session.error = false;
      session.errorReason = undefined;
      this.changes.fire();
    } catch {
      if (current()) this.reportError(session, false, 'readFailed');
    } finally {
      session.opening = false;
      if (this.session === session && session.phase === 'following' && session.pending.size > 0) this.schedule(session);
    }
  }

  private schedule(session: FollowSession): void {
    if (this.session !== session || session.phase !== 'following' || session.collecting) return;
    if (session.timer !== undefined) clearTimeout(session.timer);
    const handle = setTimeout(() => {
      if (session.timer !== handle) return;
      session.timer = undefined;
      void this.drain(session);
    }, 120);
    session.timer = handle;
  }

  private async drain(session: FollowSession): Promise<void> {
    const activityRevision = session.activityRevision;
    const epoch = session.epoch;
    const current = (): boolean => this.session === session && session.phase === 'following' &&
      !session.collecting && session.activityRevision === activityRevision && session.epoch === epoch;
    if (!current() || session.opening) return;
    session.opening = true;
    const attemptedRevision = session.revision;
    try {
      const reviewed = [...session.pending];
      const item = session.latest;
      if (reviewed.length === 0 || !item) return;
      const shown = await this.editor.show(item, current);
      if (!current()) return;
      if (!shown) {
        this.reportError(session, false, 'readFailed');
        return;
      }
      if (current()) {
        this.acknowledge(session, reviewed);
        if (session.error) {
          session.error = false;
          session.errorReason = undefined;
          this.changes.fire();
        }
      }
    } catch {
      if (current()) this.reportError(session, false, 'readFailed');
    } finally {
      session.opening = false;
      if (this.session === session && session.phase === 'paused') this.changes.fire();
      if (this.session === session && session.phase === 'following' && !session.collecting &&
        session.timer === undefined && session.pending.size > 0 &&
        (session.revision > attemptedRevision || session.activityRevision !== activityRevision)) this.schedule(session);
    }
  }

  private acknowledge(session: FollowSession, items: readonly (readonly [string, number])[]): void {
    for (const [file, revision] of items) {
      if (session.pending.get(file) === revision) session.pending.delete(file);
    }
    if (session.pending.size === 0) session.latest = undefined;
  }

  private reportError(session: FollowSession, fatal: boolean, reason: FollowWatchError): void {
    if (this.session !== session) return;
    if (reason === 'snapshotLimited') {
      if (!session.limited) {
        session.limited = true;
        void vscode.window.showWarningMessage(t('follow.snapshotLimited'));
        this.changes.fire();
      }
      return;
    }
    if (fatal) {
      this.stop();
      void vscode.window.showWarningMessage(t(`follow.${reason}`));
    } else if (!session.error) {
      session.error = true;
      session.errorReason = reason;
      this.changes.fire();
    }
  }

  private stop(): void {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.watcher?.dispose();
    this.editor.clear();
    this.changes.fire();
  }

  dispose(): void {
    this.stop();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.editor.dispose();
    this.changes.dispose();
  }
}
