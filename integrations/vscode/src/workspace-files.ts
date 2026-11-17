import { isAbsolute, normalize } from 'node:path';
import * as vscode from 'vscode';

export type WorkspaceFileResult =
  | { kind: 'found'; uri: vscode.Uri }
  | { kind: 'outside' }
  | { kind: 'notFound' };

export async function resolveWorkspaceFile(file: string): Promise<WorkspaceFileResult> {
  const absolute = isAbsolute(file);
  const absolutePath = absolute ? vscode.Uri.file(normalize(file)).path : undefined;

  let insideAnyFolder = false;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const uri =
      absolutePath !== undefined
        ? folder.uri.with({ path: absolutePath })
        : vscode.Uri.joinPath(folder.uri, file.replaceAll('\\', '/'));
    if (vscode.workspace.getWorkspaceFolder(uri) === undefined) {
      continue;
    }
    insideAnyFolder = true;
    if (await exists(uri)) {
      return { kind: 'found', uri };
    }
  }

  return absolute && !insideAnyFolder ? { kind: 'outside' } : { kind: 'notFound' };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
