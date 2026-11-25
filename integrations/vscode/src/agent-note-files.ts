import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { StopLocation } from './notes-tour.ts';
import type { SavedNoteStop } from './note-tour-state.ts';
import { resolveWorkspaceFile } from './workspace-files.ts';

export function rangeForNote(
  document: vscode.TextDocument,
  location: StopLocation,
): vscode.Range {
  const lastLine = Math.max(0, document.lineCount - 1);
  const first = Math.min(lastLine, Math.max(0, (location.startLine ?? 1) - 1));
  const last = Math.min(
    lastLine,
    Math.max(first, (location.endLine ?? location.startLine ?? 1) - 1),
  );
  return new vscode.Range(first, 0, last, document.lineAt(last).text.length);
}

export function noteAnchor(document: vscode.TextDocument, range: vscode.Range): string {
  return createHash('sha256').update(document.getText(range)).digest('hex');
}

export interface ResolvedSavedNoteStop {
  index: number;
  note: SavedNoteStop;
  document: vscode.TextDocument;
  range: vscode.Range;
  located: StopLocation;
}

/** Reencontra o trecho salvo: pela posicao, depois por hash+span unico. */
export function locateSavedRange(
  document: vscode.TextDocument,
  note: SavedNoteStop,
): { range: vscode.Range; located: StopLocation } | undefined {
  const original = rangeForNote(document, note);
  const located: StopLocation = {
    file: note.file,
    startLine: note.startLine,
    endLine: note.endLine,
  };
  if (noteAnchor(document, original) === note.anchor) {
    return { range: original, located };
  }

  // Snapshot v1 so com hash: comparar janelas do mesmo tamanho, match unico.
  const span = Math.max(1, (note.endLine ?? note.startLine ?? 1) - (note.startLine ?? 1) + 1);
  const starts: number[] = [];
  for (let line = 0; line + span <= document.lineCount; line += 1) {
    const candidate = new vscode.Range(line, 0, line + span - 1, document.lineAt(line + span - 1).text.length);
    if (noteAnchor(document, candidate) === note.anchor) {
      starts.push(line);
    }
  }
  if (starts.length !== 1) {
    return undefined;
  }
  const first = starts[0] as number;
  const last = Math.min(document.lineCount - 1, first + Math.max(0, (note.endLine ?? note.startLine ?? 1) - (note.startLine ?? 1)));
  const range = new vscode.Range(first, 0, last, document.lineAt(last).text.length);
  if (noteAnchor(document, range) !== note.anchor) {
    return undefined;
  }
  return {
    range,
    located: { file: note.file, startLine: first + 1, endLine: last + 1 },
  };
}

export async function resolveSavedNoteStops(stops: readonly SavedNoteStop[]): Promise<ResolvedSavedNoteStop[]> {
  const documents: { index: number; note: SavedNoteStop; document: vscode.TextDocument }[] = [];
  for (const [index, note] of stops.entries()) {
    const result = await resolveWorkspaceFile(note.file);
    if (result.kind !== 'found') {
      continue;
    }
    try {
      const document = await vscode.workspace.openTextDocument(result.uri);
      documents.push({ index, note, document });
    } catch {
      continue;
    }
  }

  const resolved: ResolvedSavedNoteStop[] = [];
  for (const entry of documents) {
    if (vscode.workspace.getWorkspaceFolder(entry.document.uri) === undefined) {
      continue;
    }
    const located = locateSavedRange(entry.document, entry.note);
    if (located !== undefined) {
      resolved.push({ ...entry, ...located });
    }
  }
  return resolved;
}
