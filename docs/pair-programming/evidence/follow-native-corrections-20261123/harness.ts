import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { watchFollowFiles } from '../../../../integrations/vscode/src/follow-watch.ts';
import type { GitApiLike } from '../../../../integrations/vscode/src/follow-excludes.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function activate(): void { void run(); }

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const output = process.env.RESULT_PATH ?? join(__dirname, 'result.json');
  const result: Record<string, unknown> = {
    platform: process.platform,
    vscode: vscode.version,
    folder: folder?.uri.fsPath ?? null,
    startedAt: new Date().toISOString(),
    trusted: vscode.workspace.isTrusted,
  };
  const watched: { dispose(): void }[] = [];
  let temporary: string | undefined;
  try {
    if (folder === undefined) throw new Error('workspace folder missing');
    assert.equal(relative(resolve(__dirname, '../workspace'), folder.uri.fsPath), '', 'use only the synthetic workspace prepared beside this harness');
    result.trusted = await until(() => vscode.workspace.isTrusted, 15000);
    assert.equal(result.trusted, true, 'native Git validation requires human workspace trust');
    const root = folder.uri.fsPath;
    await until(() => vscode.extensions.getExtension('vscode.git') !== undefined, 10000);
    const extension = vscode.extensions.getExtension<{ enabled: boolean; getAPI(version: 1): GitApiLike }>('vscode.git');
    result.gitPresent = extension !== undefined;
    try {
      const exported = await extension?.activate();
      result.gitEnabled = exported?.enabled;
      const api = exported?.getAPI(1);
      const repository = api?.getRepository(folder.uri) ?? await api?.openRepository(folder.uri);
      result.gitRepository = repository !== null && repository !== undefined;
      result.gitIgnoredProbe = [...(await repository?.checkIgnore([join(root, 'generated', 'g5.ts')]) ?? [])];
    } catch (error) { result.gitFailure = String(error); }
    assert.equal(result.gitPresent, true, 'built-in Git extension missing');
    assert.equal(result.gitRepository, true, 'synthetic Git repository unavailable');
    assert.equal((result.gitIgnoredProbe as string[]).length, 1, 'native Git ignore probe failed');
    const changes: { file: string; baseline?: string; saved?: string; line: number }[] = [];
    const errors: { fatal: boolean; reason: string }[] = [];
    let ready = false;
    watched.push(watchFollowFiles(folder.uri, {
      change: (change) => changes.push(change),
      ready: () => { ready = true; },
      error: (fatal, reason) => errors.push({ fatal, reason }),
    }));
    const isReady = await until(() => ready, 30000);
    result.ready = { fired: isReady, fatal: errors.some((entry) => entry.fatal), errors };
    assert.equal(isReady, true, 'watcher did not become ready');
    assert.equal(errors.length, 0, 'unexpected incomplete snapshot for ignored-file fixture');

    await writeFile(join(root, 'generated', 'g5.ts'), 'changed by native test\n');
    await sleep(1200);
    result.ignoredSave = { changes: changes.length };
    assert.equal(changes.length, 0, 'Git-ignored save escaped filtering');

    await writeFile(join(root, 'hidden', 'h.ts'), 'changed by native test\n');
    await sleep(1200);
    result.excludedSave = { changes: changes.length };
    assert.equal(changes.length, 0, 'files.exclude save escaped filtering');

    await writeFile(join(root, 'legit.ts'), 'legit two\n');
    await sleep(1500);
    const last = changes[changes.length - 1];
    result.legitSave = {
      count: changes.length,
      file: last?.file ?? null,
      baselinePreserved: last?.baseline === 'legit one\n',
      saved: last?.saved ?? null,
      line: last?.line ?? null,
      errors: errors.length,
    };
    assert.equal(changes.length, 1, 'eligible save was not emitted exactly once');
    assert.equal(last?.file, 'legit.ts');
    assert.equal(last?.baseline, 'legit one\n');
    assert.equal(last?.saved, 'legit two\n');

    temporary = await mkdtemp(join(tmpdir(), 'follow-native-junction-'));
    const junction = join(temporary, 'root');
    let junctionReady = false;
    try {
      await symlink(root, junction, process.platform === 'win32' ? 'junction' : 'dir');
        const handle = watchFollowFiles(vscode.Uri.file(junction), {
          change: () => undefined,
          ready: () => { junctionReady = true; },
          error: () => undefined,
        });
        watched.push(handle);
      await until(() => junctionReady, 30000);
    } catch (error) {
      result.junctionError = String(error);
    }
    result.junction = { ready: junctionReady };
    assert.equal(junctionReady, true, 'junction root failed readiness');
    result.passed = true;
  } catch (error) {
    result.failure = String(error);
  } finally {
    for (const handle of watched) handle.dispose();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    result.finishedAt = new Date().toISOString();
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  }
}
