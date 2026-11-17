import { describe, expect, it } from 'vitest';
import {
  displayMentionTokens,
  findMentionTrigger,
  serializeMentions,
} from '../src/webview/chat-mention-tokens.ts';

function noActionLabel(): string | undefined {
  return undefined;
}

describe('findMentionTrigger', () => {
  it('detecta arroba no início e depois de espaço ou quebra de linha', () => {
    expect(findMentionTrigger('@For', 4)).toEqual({
      trigger: '@',
      start: 0,
      query: 'For',
    });
    expect(findMentionTrigger('Ask @For', 8)).toEqual({
      trigger: '@',
      start: 4,
      query: 'For',
    });
    expect(findMentionTrigger('Ask\n@For', 8)).toEqual({
      trigger: '@',
      start: 4,
      query: 'For',
    });
  });

  it('detecta cifrão no início e depois de espaço', () => {
    expect(findMentionTrigger('$Fix', 4)).toEqual({
      trigger: '$',
      start: 0,
      query: 'Fix',
    });
    expect(findMentionTrigger('Run $Fix', 8)).toEqual({
      trigger: '$',
      start: 4,
      query: 'Fix',
    });
  });

  it('ignora gatilho no meio de uma palavra', () => {
    expect(findMentionTrigger('mail@For', 8)).toBeUndefined();
    expect(findMentionTrigger('price$5', 7)).toBeUndefined();
  });

  it('ignora quando a consulta já tem espaço', () => {
    expect(findMentionTrigger('Ask @For more', 13)).toBeUndefined();
  });

  it('usa o gatilho válido mais próximo antes do cursor', () => {
    expect(findMentionTrigger('@For $Fix', 9)).toEqual({
      trigger: '$',
      start: 5,
      query: 'Fix',
    });
    expect(findMentionTrigger('@For$Fix', 8)).toEqual({
      trigger: '@',
      start: 0,
      query: 'For$Fix',
    });
  });
});

describe('serializeMentions', () => {
  it('envia a menção escolhida no formato do Maestri', () => {
    const token = '<maestri-canvas-agent name="Forja" skill="maestri" />';

    expect(
      serializeMentions('Pergunte ao @Forja.', [{ text: '@Forja', token }]),
    ).toBe(`Pergunte ao ${token}.`);
  });

  it('não troca um nome que é só o começo de outra palavra', () => {
    const token = '<maestri-canvas-agent name="Forja" skill="maestri" />';

    expect(serializeMentions('@Forjas', [{ text: '@Forja', token }])).toBe('@Forjas');
    expect(serializeMentions('@Forja2', [{ text: '@Forja', token }])).toBe('@Forja2');
    expect(serializeMentions('@Forja.', [{ text: '@Forja', token }])).toBe(`${token}.`);
  });

  it('troca os textos mais longos primeiro', () => {
    const inserted = [
      { text: '@Forja', token: 'CURTO' },
      { text: '@Forja Longa', token: 'LONGO' },
    ];

    expect(serializeMentions('@Forja Longa e @Forja', inserted)).toBe('LONGO e CURTO');
  });
});

describe('displayMentionTokens', () => {
  it('mostra a tag de agente recebida como @Nome', () => {
    expect(
      displayMentionTokens(
        'Oi <maestri-canvas-agent name="Forja" skill="maestri" />!',
        noActionLabel,
      ),
    ).toBe('Oi @Forja!');

    expect(
      displayMentionTokens(
        '<maestri-canvas-agent skill="maestri" name="A &amp; B" />',
        noActionLabel,
      ),
    ).toBe('@A & B');
  });

  it('mostra a ação sem nome com o rótulo traduzido', () => {
    const actionLabel = (kind: string): string | undefined =>
      kind === 'createNote' ? 'Nova nota' : undefined;

    expect(
      displayMentionTokens('Use <maestri-create-note skill="maestri" />.', actionLabel),
    ).toBe('Use @Nova nota.');
  });

  it('converte kinds compostos para camelCase antes do rótulo', () => {
    const actionLabel = (kind: string): string | undefined =>
      kind === 'computerUse' ? 'Computer use' : undefined;

    expect(
      displayMentionTokens('<maestri-computer-use skill="maestri" />', actionLabel),
    ).toBe('@Computer use');
  });

  it('mantém tags desconhecidas', () => {
    const tag = '<maestri-future-action skill="maestri" />';

    expect(displayMentionTokens(`Antes ${tag} depois`, noActionLabel)).toBe(
      `Antes ${tag} depois`,
    );
  });

  it('usa o nome mesmo quando a tag não tem ação conhecida', () => {
    expect(
      displayMentionTokens(
        '<maestri-unknown-thing name="Forja" />',
        noActionLabel,
      ),
    ).toBe('@Forja');
  });
});
