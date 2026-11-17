import { describe, expect, it } from 'vitest';
import { isWireError } from '../src/errors.ts';
import { parseSavedPrompts } from '../src/saved-prompts.ts';

describe('parseSavedPrompts', () => {
  it('lê prompts salvos no formato prompts[]', () => {
    const prompts = parseSavedPrompts({
      prompts: [
        {
          id: 'p1',
          name: 'Revisar diff',
          description: 'Aponta bugs',
          text: 'Revise o diff',
          workspaceId: 'w1',
        },
        { id: 'p2', name: 'Resumo', text: 'Resuma as mudanças' },
      ],
    });

    expect(prompts).toEqual([
      {
        id: 'p1',
        name: 'Revisar diff',
        description: 'Aponta bugs',
        text: 'Revise o diff',
        workspaceId: 'w1',
      },
      { id: 'p2', name: 'Resumo', text: 'Resuma as mudanças' },
    ]);
  });

  it('aceita body no lugar de text', () => {
    expect(
      parseSavedPrompts({ savedPrompts: [{ id: 'p1', name: 'Corpo', body: 'Texto do body' }] }),
    ).toEqual([{ id: 'p1', name: 'Corpo', text: 'Texto do body' }]);

    expect(parseSavedPrompts([{ id: 'p2', name: 'Prompt', prompt: 'Texto do prompt' }])).toEqual([
      { id: 'p2', name: 'Prompt', text: 'Texto do prompt' },
    ]);

    expect(parseSavedPrompts([{ id: 'p3', name: 'Conteúdo', content: 'Texto do content' }])).toEqual(
      [{ id: 'p3', name: 'Conteúdo', text: 'Texto do content' }],
    );
  });

  it('descarta prompt sem texto', () => {
    expect(
      parseSavedPrompts({
        prompts: [
          { id: 'p1', name: 'Sem texto' },
          { id: 'p2', name: 'Só espaços', text: '   ' },
          'texto solto',
        ],
      }),
    ).toEqual([]);
  });

  it('usa nome e id como fallback um do outro', () => {
    expect(parseSavedPrompts([{ id: 'p1', text: 'Oi' }])).toEqual([
      { id: 'p1', name: 'p1', text: 'Oi' },
    ]);
    expect(parseSavedPrompts([{ name: 'Nome', text: 'Oi' }])).toEqual([
      { id: 'Nome', name: 'Nome', text: 'Oi' },
    ]);
    expect(parseSavedPrompts([{ path: 'prompts/a.md', title: 'A', text: 'Oi' }])).toEqual([
      { id: 'prompts/a.md', name: 'A', text: 'Oi' },
    ]);
  });

  it('lança resposta inválida para formato desconhecido', () => {
    const error = capture(() => parseSavedPrompts({ items: [] }));

    expect(isWireError(error)).toBe(true);
    if (isWireError(error)) {
      expect(error.messageId).toBe('invalidResponse');
    }
    expect(() => parseSavedPrompts('não é prompt')).toThrow();
  });
});

function capture(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
