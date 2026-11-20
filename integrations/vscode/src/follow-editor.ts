import * as vscode from 'vscode';
import { checkActivityTarget } from '@maestri-bridge/core';
import { resolveFollowFile } from './follow-file.ts';
import type { FollowActivity } from './follow-state.ts';
import { t } from './i18n/index.ts';

export class FollowEditor implements vscode.Disposable {
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('focusBorder'),
  });
  private readonly notes = vscode.comments.createCommentController('maestriBridgeFollow', 'Maestri');
  private thread: vscode.CommentThread | undefined;
  private editor: vscode.TextEditor | undefined;
  private ownNavigation: string | undefined;
  private column: vscode.ViewColumn | undefined;

  get uri(): vscode.Uri | undefined {
    return this.editor?.document?.uri;
  }

  begin(): void {
    this.column = vscode.window.activeTextEditor?.viewColumn;
  }

  isOwnNavigation(uri: vscode.Uri): boolean {
    return this.ownNavigation === uri.toString();
  }

  owns(thread: vscode.CommentThread): boolean {
    return this.thread === thread;
  }

  async show(
    root: vscode.Uri,
    event: FollowActivity,
    name: string,
    current: () => boolean,
  ): Promise<boolean> {
    if (!event.file || !event.range || !current()) return false;
    const file = await resolveFollowFile(root.fsPath, event.file);
    if (!file || !current()) return false;
    const uri = vscode.Uri.file(file);
    const document = await vscode.workspace.openTextDocument(uri);
    if (!current() || document.isClosed || document.getText().includes('\0') || !checkActivityTarget(event, {
      text: document.getText(), lineCount: document.lineCount, isDirty: document.isDirty,
    }).ok) return false;
    const range = new vscode.Range(event.range.startLine - 1, 0, event.range.endLine - 1, document.lineAt(event.range.endLine - 1).text.length);
    this.ownNavigation = uri.toString();
    try {
      const editor = await vscode.window.showTextDocument(document, {
        preserveFocus: true, preview: true, viewColumn: this.column ?? vscode.ViewColumn.Active,
      });
      if (!current() || document.isDirty || !checkActivityTarget(event, {
        text: document.getText(), lineCount: document.lineCount, isDirty: document.isDirty,
      }).ok) return false;
      this.clear();
      this.editor = editor;
      editor.setDecorations(this.highlight, [range]);
      if (!editor.visibleRanges.some((visible) => visible.contains(range))) {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      if (event.kind === 'decision' && event.message) {
        this.thread = this.notes.createCommentThread(uri, range, [{
          body: new vscode.MarkdownString().appendText(event.message),
          mode: vscode.CommentMode.Preview,
          author: { name },
          timestamp: new Date(),
        }]);
        this.thread.label = t('follow.decision', { name });
        this.thread.canReply = true;
        this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      }
      return true;
    } finally {
      this.ownNavigation = undefined;
    }
  }

  clear(): void {
    this.editor?.setDecorations(this.highlight, []);
    this.editor = undefined;
    this.thread?.dispose();
    this.thread = undefined;
  }

  dispose(): void {
    this.clear();
    this.highlight.dispose();
    this.notes.dispose();
  }
}
