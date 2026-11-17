import { describe, expect, it } from 'vitest';
import { findFileReferences } from '../src/webview/chat-links.ts';

function paths(text: string): string[] {
  return findFileReferences(text).map((reference) => reference.path);
}

describe('findFileReferences', () => {
  it('acha caminhos com barra mesmo sem linhas', () => {
    expect(paths('Veja src/auth/session.ts agora.')).toEqual(['src/auth/session.ts']);
    expect(paths('Edite src/auth por favor.')).toEqual(['src/auth']);
  });

  it('acha caminhos relativos com ./ e ../', () => {
    expect(paths('Abra ./a/b.tsx:3 e ../lib/c.ts.')).toEqual(['./a/b.tsx', '../lib/c.ts']);
  });

  it('lê linhas com dois-pontos e com #L', () => {
    const references = findFileReferences(
      'packages/core/src/chat.ts:42 e README.md:10-20 e src/a.ts#L10-L20 e src/b.ts#L7',
    );

    expect(references.map((reference) => [reference.path, reference.line, reference.endLine])).toEqual(
      [
        ['packages/core/src/chat.ts', 42, undefined],
        ['README.md', 10, 20],
        ['src/a.ts', 10, 20],
        ['src/b.ts', 7, undefined],
      ],
    );
  });

  it('não transforma URLs http ou https', () => {
    expect(paths('https://example.com/src/a.ts')).toEqual([]);
    expect(paths('http://example.com/a.ts:3')).toEqual([]);
  });

  it('não transforma arquivo sem barra nem linha', () => {
    expect(paths('Veja README.md agora.')).toEqual([]);
  });

  it('não aceita linha zero nem intervalo invertido', () => {
    expect(paths('README.md:0')).toEqual([]);
    expect(paths('src/a.ts:20-10')).toEqual([]);
  });

  it('não aceita extensão com mais de 8 caracteres', () => {
    expect(paths('src/a.verylongextension:3')).toEqual([]);
  });

  it('não inclui a pontuação final no caminho', () => {
    const text = 'Veja src/a.ts.';
    const refs = findFileReferences(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe('src/a.ts');
    expect(refs[0] === undefined ? '' : text.slice(refs[0].start, refs[0].end)).toBe('src/a.ts');
  });

  it('devolve posições que recortam o texto original', () => {
    const text = 'Antes src/auth/session.ts:12-14 depois';
    const refs = findFileReferences(text);

    expect(refs).toHaveLength(1);
    expect(refs[0] === undefined ? '' : text.slice(refs[0].start, refs[0].end)).toBe(
      'src/auth/session.ts:12-14',
    );
  });

  it('acha várias referências em ordem', () => {
    expect(paths('src/a.ts, src/b.ts:2 e README.md:3-4')).toEqual([
      'src/a.ts',
      'src/b.ts',
      'README.md',
    ]);
  });

  it('devolve lista vazia sem referências', () => {
    expect(findFileReferences('Só uma frase comum, sem caminhos.')).toEqual([]);
  });
});
