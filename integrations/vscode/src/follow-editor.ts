import * as vscode from 'vscode';
import type { FollowChange } from './follow-watch.ts';

const scheme = 'maestri-follow';
const revealTimeoutMs = 1200;

interface Preview {
  attempt: number;
  uri: vscode.Uri;
  text: string;
  line: number;
  current: () => boolean;
  finish: (shown: boolean) => void;
}

export class FollowEditor implements vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  private readonly provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    onDidChange: this.changes.event,
    provideTextDocumentContent: (uri) => this.documents.get(uri.toString()) ?? '',
  });
  private readonly documentChanges = vscode.workspace.onDidChangeTextDocument(() => this.reveal());
  private readonly documentCloses = vscode.workspace.onDidCloseTextDocument(({ uri }) => {
    if (uri.scheme === scheme) this.documents.delete(uri.toString());
  });
  private readonly visibleChanges = vscode.window.onDidChangeVisibleTextEditors(() => this.reveal());
  private session = 0;
  private attempt = 0;
  private column: vscode.ViewColumn | undefined;
  private preview: Preview | undefined;

  begin(): void {
    this.clear();
    this.session++;
    const group = vscode.window.tabGroups.activeTabGroup;
    this.column = group.activeTab?.input instanceof vscode.TabInputWebview
      ? vscode.ViewColumn.Beside
      : group.viewColumn;
  }

  show(change: FollowChange, current: () => boolean): Promise<boolean> {
    if (!current()) return Promise.resolve(false);
    this.cancelPending();
    const before = this.uri(change.file, 'initial');
    const after = this.uri(change.file, 'saved');
    const baseline = change.baseline ?? '';
    const text = (change.saved ?? '').replace(/\r\n?/g, '\n');
    const previousBaseline = this.documents.get(before.toString());
    const previousSaved = this.documents.get(after.toString());
    this.documents.set(before.toString(), baseline);
    this.documents.set(after.toString(), text);

    return new Promise((resolve) => {
      const preview: Preview = {
        attempt: ++this.attempt, uri: after, text, line: change.line, current,
        finish: (shown) => {
          if (this.preview !== preview) return;
          this.preview = undefined;
          clearTimeout(timeout);
          if (!shown) {
            this.restore(before, baseline, previousBaseline);
            this.restore(after, text, previousSaved);
          }
          resolve(shown);
        },
      };
      this.preview = preview;
      const timeout = setTimeout(() => preview.finish(false), revealTimeoutMs);
      try {
        if (previousSaved !== undefined && previousSaved !== text) this.changes.fire(after);
        if (this.reveal(preview) || this.preview !== preview) return;
        this.openDiff(before, after, change.file, preview.attempt);
      } catch {
        preview.finish(false);
      }
    });
  }

  private openDiff(before: vscode.Uri, after: vscode.Uri, file: string, attempt: number): void {
    void Promise.resolve(vscode.commands.executeCommand('vscode.diff', before, after, file, {
      preserveFocus: true,
      preview: true,
      viewColumn: this.column,
    })).then(() => {
      if (this.preview?.attempt === attempt) this.reveal();
    }).catch(() => {
      if (this.preview?.attempt === attempt) this.cancelPending();
    });
  }

  private restore(uri: vscode.Uri, text: string, previous: string | undefined): void {
    const key = uri.toString();
    if (this.documents.get(key) !== text || previous === text) return;
    if (previous === undefined) {
      this.documents.delete(key);
    } else {
      this.documents.set(key, previous);
      this.changes.fire(uri);
    }
  }

  private uri(file: string, revision: 'initial' | 'saved'): vscode.Uri {
    return vscode.Uri.from({ scheme, path: '/' + file, query: this.session + ':' + revision });
  }

  private reveal(preview = this.preview): boolean {
    if (!preview || this.preview !== preview) return false;
    if (!preview.current()) {
      preview.finish(false);
      return false;
    }
    const editor = vscode.window.visibleTextEditors.find(({ document }) =>
      document.uri.toString() === preview.uri.toString() && document.getText().replace(/\r\n?/g, '\n') === preview.text,
    );
    if (!editor) return false;
    try {
      const line = Math.min(preview.line, editor.document.lineCount - 1);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.column = editor.viewColumn ?? this.column;
      preview.finish(true);
      return true;
    } catch {
      preview.finish(false);
      return false;
    }
  }

  cancelPending(): void {
    this.preview?.finish(false);
  }

  clear(): void {
    this.documents.clear();
    this.cancelPending();
    this.column = undefined;
  }

  dispose(): void {
    this.clear();
    this.documentChanges.dispose();
    this.visibleChanges.dispose();
    this.documentCloses.dispose();
    this.provider.dispose();
    this.changes.dispose();
  }
}
