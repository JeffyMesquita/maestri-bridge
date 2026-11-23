import * as vscode from 'vscode';

export interface GitRepositoryLike {
  checkIgnore(paths: string[]): Promise<Set<string>>;
}

export interface GitApiLike {
  openRepository(uri: vscode.Uri): Promise<GitRepositoryLike | null>;
  getRepository(uri: vscode.Uri): GitRepositoryLike | null | undefined;
}

interface GitExtensionLike {
  activate(): Promise<unknown>;
  exports: { getAPI(version: 1): GitApiLike };
}

export type GitIgnoreResult =
  | { kind: 'known'; paths: Set<string> }
  | { kind: 'noRepository' }
  | { kind: 'unavailable' };

export async function gitIgnored(root: string, paths: string[]): Promise<GitIgnoreResult> {
  if (paths.length === 0) return { kind: 'known', paths: new Set() };
  try {
    const extension = vscode.extensions.getExtension<unknown>('vscode.git') as GitExtensionLike | undefined;
    if (extension === undefined) return { kind: 'unavailable' };
    await extension.activate();
    const api = extension.exports.getAPI(1);
    const uri = vscode.Uri.file(root);
    const repository = api.getRepository(uri) ?? await api.openRepository(uri);
    if (repository === null) return { kind: 'noRepository' };
    return { kind: 'known', paths: await repository.checkIgnore(paths) };
  } catch {
    return { kind: 'unavailable' };
  }
}
