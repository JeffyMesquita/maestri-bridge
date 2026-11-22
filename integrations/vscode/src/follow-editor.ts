import * as vscode from 'vscode';
import type { FollowChange } from './follow-watch.ts';

const scheme = 'maestri-follow';

interface Preview {
  uri: vscode.Uri;
  text: string;
  line: number;
  current: () => boolean;
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

  async show(change: FollowChange, current: () => boolean): Promise<boolean> {
    if (!current()) return false;
    const before = this.uri(change.file, 'initial');
    const after = this.uri(change.file, 'saved');
    const text = (change.saved ?? '').replace(/\r\n?/g, '\n');
    const preview = { uri: after, text, line: change.line, current };
    this.preview = preview;
    this.documents.set(before.toString(), change.baseline ?? '');
    const previous = this.documents.get(after.toString());
    this.documents.set(after.toString(), text);
    if (previous !== undefined && previous !== text) this.changes.fire(after);

    if (!this.reveal()) {
      await vscode.commands.executeCommand('vscode.diff', before, after, change.file, {
        preserveFocus: true,
        preview: true,
        viewColumn: this.column,
      });
      this.reveal();
    }

    return current();
  }

  private uri(file: string, revision: 'initial' | 'saved'): vscode.Uri {
    return vscode.Uri.from({ scheme, path: '/' + file, query: this.session + ':' + revision });
  }

  private reveal(): boolean {
    const preview = this.preview;
    if (!preview || !preview.current()) return false;
    const editor = vscode.window.visibleTextEditors.find(({ document }) =>
      document.uri.toString() === preview.uri.toString() && document.getText().replace(/\r\n?/g, '\n') === preview.text,
    );
    if (!editor) return false;
    const line = Math.min(preview.line, editor.document.lineCount - 1);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.preview = undefined;
    this.column = editor.viewColumn ?? this.column;
    return true;
  }

  clear(): void {
    this.preview = undefined;
    this.documents.clear();
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
