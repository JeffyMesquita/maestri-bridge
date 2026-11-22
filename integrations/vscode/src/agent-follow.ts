import { isAbsolute, relative } from 'node:path';
import * as vscode from 'vscode';
import type { AgentMonitor } from './agent-monitor.ts';
import { FollowEditor } from './follow-editor.ts';
import { watchFollowFiles } from './follow-watch.ts';
import type { FollowChange } from './follow-watch.ts';
import { t } from './i18n/index.ts';
import type { ExtensionServices } from './services.ts';
import type { AgentTarget } from './target-memory.ts';

type FollowPhase = 'starting' | 'following' | 'paused';

interface FollowSession {
  target: AgentTarget;
  phase: FollowPhase;
  pending: Map<string, FollowChange>;
  root?: vscode.Uri;
  watcher?: vscode.Disposable;
  error?: boolean;
  opening?: boolean;
  choosing?: boolean;
}

export class AgentFollow implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly editor = new FollowEditor();
  private readonly subscriptions: vscode.Disposable[];
  private session: FollowSession | undefined;

  get summary(): { phase: FollowPhase; pendingCount: number; error?: boolean } | undefined {
    const session = this.session;
    return session && { phase: session.phase, pendingCount: session.pending.size, error: session.error };
  }

  constructor(services: ExtensionServices, private readonly monitor: AgentMonitor) {
    this.subscriptions = [
      vscode.window.onDidChangeTextEditorSelection(({ kind }) => {
        if (kind === vscode.TextEditorSelectionChangeKind.Keyboard || kind === vscode.TextEditorSelectionChangeKind.Mouse) {
          const session = this.session;
          if (session?.phase === 'following') {
            session.phase = 'paused';
            this.changes.fire();
          }
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

    const session: FollowSession = { target, phase: 'starting', pending: new Map() };
    this.session = session;
    this.changes.fire();
    try {
      const workspace = this.monitor.workspaces.find(({ id }) => id === target.workspaceId);
      const mappedPath = target.floorId === undefined || target.floorId === 'ground'
        ? workspace?.workingDirectory
        : undefined;
      const mapped = mappedPath && isAbsolute(mappedPath)
        ? folders.find(({ uri }) => relative(uri.fsPath, mappedPath) === '')
        : undefined;
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
        change: (change) => {
          if (this.session !== session) return;
          session.pending.delete(change.file);
          session.pending.set(change.file, change);
          if (session.phase === 'paused') this.changes.fire();
          if (session.phase === 'following') void this.drain(session);
        },
        ready: () => {
          if (this.session !== session) return;
          session.phase = 'following';
          this.changes.fire();
          void this.drain(session);
        },
        error: (fatal) => this.reportError(session, fatal),
      });
    } catch {
      this.reportError(session, true);
    }
  }

  async viewPending(): Promise<void> {
    const session = this.session;
    if (session?.phase !== 'paused' || session.choosing || session.opening) return;
    const candidates = [...session.pending.values()].reverse();
    if (candidates.length === 0) return;
    session.choosing = true;
    const current = (): boolean => this.session === session && session.phase === 'paused';
    try {
      const chosen = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(
        candidates.map(({ file }) => ({ label: file })),
        { title: t('follow.view') },
      ));
      if (!chosen || !current()) return;
      const file = 'file' in chosen ? chosen.file : chosen.label;
      const change = session.pending.get(file);
      if (!change) return;
      const reviewed = [...session.pending.values()];
      if (!(await this.editor.show(change, current)) || !current()) return;
      this.acknowledge(session, reviewed);
      session.phase = 'following';
      session.error = false;
      this.changes.fire();
    } catch {
      this.reportError(session, false);
    } finally {
      session.choosing = false;
      if (current() || this.session === session) void this.drain(session);
    }
  }

  private async drain(session: FollowSession): Promise<void> {
    const current = (): boolean => this.session === session && session.phase === 'following';
    if (!current() || session.opening || session.choosing) return;
    session.opening = true;
    try {
      for (const item of session.pending.values()) {
        if (!current()) break;
        if (!(await this.editor.show(item, current)) || !current()) break;
        this.acknowledge(session, [item]);
        if (session.error) {
          session.error = false;
          this.changes.fire();
        }
      }
    } catch {
      this.reportError(session, false);
    } finally {
      session.opening = false;
      if (this.session === session && session.phase === 'paused') this.changes.fire();
    }
  }

  private acknowledge(session: FollowSession, items: readonly FollowChange[]): void {
    for (const item of items) {
      if (session.pending.get(item.file) === item) session.pending.delete(item.file);
    }
  }

  private reportError(session: FollowSession, fatal: boolean): void {
    if (this.session !== session) return;
    if (fatal) {
      this.stop();
      void vscode.window.showWarningMessage(t('follow.readFailed'));
    } else if (!session.error) {
      session.error = true;
      this.changes.fire();
    }
  }

  private stop(): void {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
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
