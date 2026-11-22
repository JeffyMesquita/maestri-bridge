import * as vscode from 'vscode';
import { checkActivityTarget } from '@maestri-bridge/core';
import { resolveFollowFile } from './follow-file.ts';
import type { FollowActivity } from './follow-state.ts';

const NAVIGATION_SETTLE_MS = 300;
const EMPHASIS_MS = 1200;
const SWEEP_MS = 160;

export class FollowEditor implements vscode.Disposable {
  private readonly highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 2px',
    borderColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private emphasisTimer: ReturnType<typeof setTimeout> | undefined;
  private editor: vscode.TextEditor | undefined;
  private ownNavigation: { target: string; previous?: string; settledAt?: number } | undefined;
  private column: vscode.ViewColumn | undefined;
  private readonly documentChanges = vscode.workspace.onDidChangeTextDocument(({ document }) => {
    if (document === this.editor?.document) this.cancelEmphasis();
  });

  get uri(): vscode.Uri | undefined {
    return this.editor?.document?.uri;
  }

  begin(beside = false): void {
    const active = vscode.window.activeTextEditor?.viewColumn;
    this.column = beside && active !== undefined ? vscode.ViewColumn.Beside : active;
  }

  isOwnNavigation(uri: vscode.Uri): boolean {
    const navigation = this.ownNavigation;
    if (!navigation) return false;
    const path = uri.toString();
    if (navigation.settledAt === undefined) {
      return path === navigation.target || path === navigation.previous;
    }
    return path === navigation.target && Date.now() - navigation.settledAt < NAVIGATION_SETTLE_MS;
  }

  async show(
    root: vscode.Uri,
    event: FollowActivity,
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
    const navigation: NonNullable<FollowEditor['ownNavigation']> = {
      target: uri.toString(),
      previous: vscode.window.activeTextEditor?.document.uri.toString(),
    };
    this.ownNavigation = navigation;
    try {
      const editor = await vscode.window.showTextDocument(document, {
        preserveFocus: true, preview: true, viewColumn: this.column ?? vscode.ViewColumn.Active,
      });
      if (!current() || document.isClosed || document.isDirty || !checkActivityTarget(event, {
        text: document.getText(), lineCount: document.lineCount, isDirty: document.isDirty,
      }).ok) return false;
      this.cancelEmphasis();
      this.editor = editor;
      this.column = editor.viewColumn ?? this.column;
      if (!editor.visibleRanges.some((visible) => visible.contains(range))) {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
      this.emphasize(editor, range, current);
      return true;
    } finally {
      navigation.settledAt = Date.now();
    }
  }

  clear(): void {
    this.ownNavigation = undefined;
    this.cancelEmphasis();
    this.editor = undefined;
  }

  cancelEmphasis(): void {
    if (this.emphasisTimer !== undefined) clearTimeout(this.emphasisTimer);
    this.emphasisTimer = undefined;
    this.editor?.setDecorations(this.highlight, []);
  }

  private emphasize(editor: vscode.TextEditor, range: vscode.Range, current: () => boolean): void {
    const document = editor.document;
    const version = document.version;
    const frames = vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion', 'auto') === 'off'
      ? Math.min(8, range.end.line - range.start.line + 1)
      : 1;
    let frame = 0;
    const paint = (): void => {
      this.emphasisTimer = undefined;
      if (!current() || this.editor !== editor || document.isClosed || document.isDirty || document.version !== version) {
        this.cancelEmphasis();
        return;
      }
      frame++;
      const end = range.start.line + Math.ceil((range.end.line - range.start.line + 1) * frame / frames) - 1;
      editor.setDecorations(this.highlight, [new vscode.Range(range.start.line, 0, end, document.lineAt(end).text.length)]);
      this.emphasisTimer = setTimeout(
        frame < frames ? paint : () => this.cancelEmphasis(),
        frame < frames ? SWEEP_MS / frames : EMPHASIS_MS,
      );
    };
    paint();
  }

  dispose(): void {
    this.clear();
    this.documentChanges.dispose();
    this.highlight.dispose();
  }
}
