import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const { Range } = vi.hoisted(() => ({
  Range: class {
    constructor(
      readonly start: number,
      readonly startChar: number,
      readonly end: number,
      readonly endChar: number,
    ) {}
  },
}));

vi.mock('vscode', () => ({
  Range,
  workspace: { getWorkspaceFolder: () => ({}) },
}));

import { locateSavedRange } from '../src/agent-note-files.ts';
import type { SavedNoteStop } from '../src/note-tour-state.ts';

const anchorFor = (text: string): string => createHash('sha256').update(text).digest('hex');

function document(lines: string[]) {
  return {
    lineCount: lines.length,
    lineAt: (index: number) => ({ text: lines[index] }),
    getText: (range: { start: number; end: number }) =>
      lines.slice(range.start, range.end + 1).join('\n'),
  };
}

describe('locateSavedRange', () => {
  const first = 'const a = 1;';
  const second = 'const b = 2;';
  const note: SavedNoteStop = {
    file: '/workspace/example.ts',
    startLine: 2,
    endLine: 3,
    anchor: anchorFor(`${first}\n${second}`),
    name: 'Maia',
    viewed: false,
    comments: [{ author: 'Maia', text: 'Revise.', isReply: false }],
  };

  it('aceita a posicao atual quando o hash confere', () => {
    const found = locateSavedRange(document(['first', first, second, 'tail']) as never, note);
    expect(found?.located).toEqual({ file: note.file, startLine: 2, endLine: 3 });
  });

  it('relocaliza trecho movido de snapshot v1 somente com hash', () => {
    const found = locateSavedRange(
      document(['header', 'other', first, second, 'tail']) as never,
      note,
    );
    expect(found?.located).toEqual({ file: note.file, startLine: 3, endLine: 4 });
  });

  it('nao escolhe match ambiguo', () => {
    const duplicated = document(['a', first, second, 'x', first, second]) as never;
    expect(locateSavedRange(duplicated, { ...note, startLine: 1, endLine: 2 })).toBeUndefined();
  });
});
