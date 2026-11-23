import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  repository: null as { checkIgnore: (paths: string[]) => Promise<Set<string>> } | null,
  openFails: false,
  openRepository: vi.fn(),
}));

vi.mock('vscode', () => ({
  Uri: { file: (path: string) => ({ fsPath: path }) },
  extensions: {
    getExtension: () => ({
      activate: async () => undefined,
      exports: {
        getAPI: () => ({
          getRepository: () => state.repository,
          openRepository: async (uri: { fsPath: string }) => {
            state.openRepository(uri);
            if (state.openFails) throw new Error('no repository');
            return state.repository;
          },
        }),
      },
    }),
  },
}));

const { gitIgnored } = await import('../src/follow-excludes.ts');

describe('git ignore bridge', () => {
  it('opens an undiscovered repository with the public Uri argument', async () => {
    state.repository = null;
    state.openFails = false;
    state.openRepository.mockClear();
    await gitIgnored('/repo', ['/repo/a.ts']);
    expect(state.openRepository).toHaveBeenCalledExactlyOnceWith({ fsPath: '/repo' });
  });
  it('returns the repository ignore set for a batch', async () => {
    state.openFails = false;
    state.repository = { checkIgnore: async (paths) => new Set(paths.filter((value) => value.includes('gen'))) };
    expect(await gitIgnored('/repo', ['/repo/gen/a.ts', '/repo/src/b.ts'])).toEqual({
      kind: 'known', paths: new Set(['/repo/gen/a.ts']),
    });
  });

  it('reports unavailable when the repository cannot be opened', async () => {
    state.repository = null;
    state.openFails = true;
    expect(await gitIgnored('/repo', ['/repo/a.ts'])).toEqual({ kind: 'unavailable' });
  });

  it('reports unavailable when checkIgnore rejects', async () => {
    state.openFails = false;
    state.repository = { checkIgnore: async () => { throw new Error('git down'); } };
    expect(await gitIgnored('/repo', ['/repo/a.ts'])).toEqual({ kind: 'unavailable' });
  });

  it('distinguishes no repository from a failed Git query', async () => {
    state.repository = null;
    state.openFails = false;
    expect(await gitIgnored('/repo', ['/repo/a.ts'])).toEqual({ kind: 'noRepository' });
    state.openFails = true;
    expect(await gitIgnored('/repo', ['/repo/a.ts'])).toEqual({ kind: 'unavailable' });
  });

  it('short-circuits an empty batch', async () => {
    state.repository = null;
    state.openFails = true;
    expect(await gitIgnored('/repo', [])).toEqual({ kind: 'known', paths: new Set() });
  });
});
