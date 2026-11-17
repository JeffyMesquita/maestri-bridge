import { describe, expect, it } from 'vitest';
import { isCodeFromSelection, normalizePastedCode } from '../src/chat-paste.ts';

describe('normalizePastedCode', () => {
  it('normaliza quebras de linha e tira espaços e quebras do fim', () => {
    expect(normalizePastedCode('a\r\nb\rc\n \n')).toBe('a\nb\nc');
    expect(normalizePastedCode('a\nb   ')).toBe('a\nb');
  });
});

describe('isCodeFromSelection', () => {
  it('trata como referência o código colado igual à seleção do editor', () => {
    const selection = 'const a = 1;\nconst b = 2;';

    expect(isCodeFromSelection(selection, [selection])).toBe(true);
    expect(isCodeFromSelection(`${selection}\n`, [selection])).toBe(true);
  });

  it('aceita a seleção que começa no meio da linha, com indentação diferente', () => {
    const selection = 'const a = 1;\n    return a;';
    const pasted = '    const a = 1;\n        return a;';

    expect(isCodeFromSelection(pasted, [selection])).toBe(true);
  });

  it('mantém como texto uma colagem de uma linha só', () => {
    expect(isCodeFromSelection('const a = 1;', ['const a = 1;'])).toBe(false);
    expect(isCodeFromSelection('const a = 1;\n', ['const a = 1;'])).toBe(false);
  });

  it('mantém como texto um código diferente da seleção', () => {
    const pasted = 'const a = 1;\nconst b = 2;';
    const selection = 'const a = 1;\nconst b = 3;';

    expect(isCodeFromSelection(pasted, [selection])).toBe(false);
    expect(isCodeFromSelection(pasted, [])).toBe(false);
  });

  it('ignora diferenças de quebra de linha do Windows', () => {
    const pasted = 'const a = 1;\r\nconst b = 2;\r\n';
    const selection = 'const a = 1;\nconst b = 2;';

    expect(isCodeFromSelection(pasted, [selection])).toBe(true);
  });
});
