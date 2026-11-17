import { describe, expect, it } from 'vitest';
import type { ChatMention, SavedPrompt, TerminalFileEntry } from '@maestri-bridge/core';
import {
  catalogMentionViews,
  fileMentionViews,
  mentionToken,
  savedPromptViews,
} from '../src/chat-mentions.ts';

function mention(overrides: Partial<ChatMention> & { name: string }): ChatMention {
  return {
    kind: 'agent',
    id: overrides.name,
    isOnActiveFloor: false,
    sectionOrder: 0,
    order: 0,
    depth: 0,
    ...overrides,
  };
}

function file(relativePath: string, isDirectory = false): TerminalFileEntry {
  return {
    relativePath,
    name: relativePath.split('/').at(-1) ?? relativePath,
    isDirectory,
  };
}

function savedPrompt(overrides: Partial<SavedPrompt> & { name: string }): SavedPrompt {
  return {
    id: overrides.name,
    text: `Texto de ${overrides.name}`,
    ...overrides,
  };
}

describe('mentionToken', () => {
  it('serializa um agente como a tag de agente do Maestri, escapando aspas no nome', () => {
    expect(mentionToken(mention({ name: 'Nina "A" & <B>', kind: 'agent' }))).toBe(
      '<maestri-canvas-agent name="Nina &quot;A&quot; &amp; &lt;B&gt;" skill="maestri" />',
    );
  });

  it('serializa notas, portais, andares e o maestro', () => {
    expect(mentionToken(mention({ name: 'Nota', kind: 'note' }))).toBe(
      '<maestri-canvas-note name="Nota" skill="maestri" />',
    );
    expect(mentionToken(mention({ name: 'Portal', kind: 'portal' }))).toBe(
      '<maestri-canvas-portal name="Portal" skill="maestri" />',
    );
    expect(mentionToken(mention({ name: 'Andar 2', kind: 'floor' }))).toBe(
      '<maestri-floor name="Andar 2" skill="maestri-manager" />',
    );
    expect(mentionToken(mention({ name: 'Maestro', kind: 'maestro' }))).toBe(
      '<maestri-maestro skill="maestri-manager" />',
    );
  });

  it('serializa as ações com a skill certa', () => {
    expect(mentionToken(mention({ name: 'Criar nota', kind: 'createNote' }))).toBe(
      '<maestri-create-note skill="maestri" />',
    );
    expect(mentionToken(mention({ name: 'Criar portal', kind: 'createPortal' }))).toBe(
      '<maestri-create-portal skill="maestri-portal" />',
    );
    expect(
      mentionToken(mention({ name: 'Criar portal de dispositivo', kind: 'createDevicePortal' })),
    ).toBe('<maestri-create-device-portal skill="maestri-portal-devices" />');
    expect(mentionToken(mention({ name: 'Criar andar', kind: 'createFloor' }))).toBe(
      '<maestri-create-floor skill="maestri-workspace" />',
    );
    expect(mentionToken(mention({ name: 'Notificações', kind: 'notifications' }))).toBe(
      '<maestri-notifications skill="maestri" />',
    );
    expect(mentionToken(mention({ name: 'Rotinas', kind: 'routines' }))).toBe(
      '<maestri-routines skill="maestri-routines" />',
    );
    expect(mentionToken(mention({ name: 'Workspaces', kind: 'workspaces' }))).toBe(
      '<maestri-workspaces skill="maestri-workspace" />',
    );
    expect(mentionToken(mention({ name: 'Computador', kind: 'computerUse' }))).toBe(
      '<maestri-computer-use skill="maestri-computer" />',
    );
  });

  it('ignora tipos de menção desconhecidos', () => {
    expect(mentionToken(mention({ name: 'Arquivo', kind: 'file' }))).toBeUndefined();
    expect(mentionToken(mention({ name: 'Outro', kind: 'other' }))).toBeUndefined();
    expect(catalogMentionViews([mention({ name: 'Outro', kind: 'other' })], '')).toEqual([]);
  });
});

describe('catalogMentionViews', () => {
  it('lista andares, notas, portais e ações além dos agentes, na ordem das seções', () => {
    const mentions = [
      mention({ name: 'Criar andar', kind: 'createFloor', sectionOrder: 3 }),
      mention({ name: 'Nina', kind: 'agent', sectionOrder: 1 }),
      mention({ name: 'Andar 2', kind: 'floor', sectionOrder: 0 }),
      mention({ name: 'Nota', kind: 'note', sectionOrder: 0, order: 1 }),
      mention({ name: 'Portal', kind: 'portal', sectionOrder: 2 }),
      mention({ name: 'Maestro', kind: 'maestro', sectionOrder: 1, order: 1 }),
    ];

    const views = catalogMentionViews(mentions, '');

    expect(views.map((view) => view.label)).toEqual([
      'Andar 2',
      'Nota',
      'Nina',
      'Maestro',
      'Portal',
      'Criar andar',
    ]);
    expect(views.map((view) => view.kind)).toEqual([
      'floor',
      'note',
      'agent',
      'agent',
      'portal',
      'action',
    ]);
    expect(views.every((view) => view.token !== undefined)).toBe(true);
  });

  it('ordena o andar atual antes dentro da mesma seção', () => {
    const mentions = [
      mention({ name: 'Fora', isOnActiveFloor: false, sectionOrder: 1, order: 0 }),
      mention({ name: 'Dentro', isOnActiveFloor: true, sectionOrder: 1, order: 5 }),
    ];

    expect(catalogMentionViews(mentions, '').map((view) => view.label)).toEqual([
      'Dentro',
      'Fora',
    ]);
  });

  it('filtra pelo texto digitado', () => {
    const mentions = [
      mention({ name: 'Nina', kind: 'agent' }),
      mention({ name: 'Bia', kind: 'agent', tokenName: 'bia-dev' }),
      mention({ name: 'Andar 2', kind: 'floor' }),
    ];

    expect(catalogMentionViews(mentions, '  NI ').map((view) => view.label)).toEqual(['Nina']);
    expect(catalogMentionViews(mentions, 'DEV').map((view) => view.label)).toEqual(['Bia']);
    expect(catalogMentionViews(mentions, 'andar').map((view) => view.label)).toEqual(['Andar 2']);
    expect(catalogMentionViews(mentions, 'zzz')).toEqual([]);
  });

  it('monta o item com token, seção, detalhe e insertText pelo nome', () => {
    const views = catalogMentionViews(
      [
        mention({
          name: 'Nina',
          kind: 'agent',
          section: 'Agentes',
          floorName: 'Andar 2',
        }),
      ],
      '',
    );

    expect(views[0]).toEqual({
      kind: 'agent',
      label: 'Nina',
      insertText: '@Nina',
      section: 'Agentes',
      token: '<maestri-canvas-agent name="Nina" skill="maestri" />',
      detail: 'Andar 2',
    });
  });

  it('só mostra o andar como detalhe para agente, nota e portal', () => {
    const views = catalogMentionViews(
      [
        mention({ name: 'Andar 2', kind: 'floor', floorName: 'Andar 2' }),
        mention({ name: 'Rotinas', kind: 'routines', floorName: 'Andar 2' }),
        mention({ name: 'Nota', kind: 'note', floorName: 'Andar 2' }),
        mention({ name: 'Portal', kind: 'portal', floorName: 'Andar 2' }),
      ],
      '',
    );

    expect(views.map((view) => view.detail)).toEqual([undefined, undefined, 'Andar 2', 'Andar 2']);
  });

  it('limita a quarenta menções', () => {
    const mentions = Array.from({ length: 45 }, (_, index) =>
      mention({ name: `Agente ${index}`, kind: 'agent', order: index }),
    );

    expect(catalogMentionViews(mentions, '')).toHaveLength(40);
  });
});

describe('savedPromptViews', () => {
  it('mostra prompts globais e do workspace do agente, não de outros workspaces', () => {
    const prompts = [
      savedPrompt({ name: 'Global' }),
      savedPrompt({ name: 'Do alvo', workspaceId: 'w1' }),
      savedPrompt({ name: 'De outro', workspaceId: 'w2' }),
    ];

    expect(savedPromptViews(prompts, '', 'w1').map((view) => view.label)).toEqual([
      'Do alvo',
      'Global',
    ]);
  });

  it('insere o texto do prompt ao escolher', () => {
    const views = savedPromptViews(
      [savedPrompt({ name: 'Resumo', text: 'Resuma o diff', description: 'Curto' })],
      '',
      'w1',
    );

    expect(views[0]).toEqual({
      kind: 'prompt',
      label: 'Resumo',
      detail: 'Curto',
      section: 'prompts',
      insertText: 'Resuma o diff',
    });
  });

  it('filtra prompts pelo nome ou descrição', () => {
    const prompts = [
      savedPrompt({ name: 'Revisar', description: 'Aponta bugs' }),
      savedPrompt({ name: 'Resumo', description: 'Curto' }),
    ];

    expect(savedPromptViews(prompts, 'Bugs', 'w1').map((view) => view.label)).toEqual([
      'Revisar',
    ]);
    expect(savedPromptViews(prompts, '  RESU ', 'w1').map((view) => view.label)).toEqual([
      'Resumo',
    ]);
    expect(savedPromptViews(prompts, 'zzz', 'w1')).toEqual([]);
  });

  it('ordena por nome e limita a vinte prompts', () => {
    const prompts = Array.from({ length: 25 }, (_, index) =>
      savedPrompt({ name: `Prompt ${String(index).padStart(2, '0')}` }),
    );

    const views = savedPromptViews(prompts, '', 'w1');
    expect(views).toHaveLength(20);
    expect(views[0]?.label).toBe('Prompt 00');
    expect(views[19]?.label).toBe('Prompt 19');
  });
});

describe('fileMentionViews', () => {
  it('não sugere pastas como menção', () => {
    const views = fileMentionViews([file('src/app.ts'), file('src', true)]);

    expect(views).toHaveLength(1);
    expect(views[0]?.label).toBe('app.ts');
    expect(views[0]?.insertText).toBe('@src/app.ts');
  });

  it('limita a vinte arquivos', () => {
    const entries = Array.from({ length: 25 }, (_, index) => file(`src/f${index}.ts`));

    expect(fileMentionViews(entries)).toHaveLength(20);
  });

  it('sugere o arquivo na seção de arquivos, com o caminho como detalhe', () => {
    expect(fileMentionViews([file('src/app.ts')])).toEqual([
      {
        kind: 'file',
        label: 'app.ts',
        detail: 'src/app.ts',
        section: 'files',
        insertText: '@src/app.ts',
      },
    ]);
  });
});
