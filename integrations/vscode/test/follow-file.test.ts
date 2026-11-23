import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { followRootError, isFollowFileAllowed, pinFollowRoot, readFollowFile, resolveFollowFile } from '../src/follow-file.ts';

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('follow file boundary', () => {
  it('rejects secret files, traversal and Windows alternate streams', () => {
    for (const file of ['.env', '.env.local', 'src/.ssh/id_rsa', 'keys/server.pem', '../a.ts', 'a.ts:stream']) {
      expect(isFollowFileAllowed(file), file).toBe(false);
    }
    expect(isFollowFileAllowed('src/features/orders.ts')).toBe(true);
  });
  it('resolves only existing small files inside the physical root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'maestri-follow-')); temporary.push(parent);
    const root = join(parent, 'project'); await mkdir(root);
    await writeFile(join(root, 'a.ts'), 'hello');
    await writeFile(join(root, 'large.ts'), Buffer.alloc(1024 * 1024 + 1));
    expect(await resolveFollowFile(root, 'a.ts')).toBe(join(await realpath(root), 'a.ts'));
    expect(await resolveFollowFile(root, 'missing.ts')).toBeUndefined();
    expect(await resolveFollowFile(root, 'large.ts')).toBeUndefined();
    expect(await resolveFollowFile(root, '../outside.ts')).toBeUndefined();
  });
  it('rejects a junction or symlink pointing outside the root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'maestri-follow-')); temporary.push(parent);
    const root = join(parent, 'project'); const outside = join(parent, 'outside');
    await mkdir(root); await mkdir(outside); await writeFile(join(outside, 'a.ts'), 'secret');
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await resolveFollowFile(root, 'linked/a.ts')).toBeUndefined();
  });

  it('resolves a symlinked root to the physical path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'maestri-follow-')); temporary.push(parent);
    const real = join(parent, 'real'); const link = join(parent, 'link');
    await mkdir(real); await writeFile(join(real, 'a.ts'), 'hello');
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await resolveFollowFile(link, 'a.ts')).toBe(join(await realpath(real), 'a.ts'));
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked file even when the target is inside the root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'maestri-follow-')); temporary.push(parent);
    const root = join(parent, 'project'); await mkdir(root);
    await writeFile(join(root, 'real.ts'), 'data');
    await symlink(join(root, 'real.ts'), join(root, 'link.ts'), 'file');
    expect(await resolveFollowFile(root, 'link.ts')).toBeUndefined();
    expect(await readFollowFile(root, 'link.ts')).toBeUndefined();
  });

  it('will not reauthorize a replacement path when reading with a pinned root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'maestri-follow-')); temporary.push(parent);
    const root = join(parent, 'project');
    await mkdir(root);
    await writeFile(join(root, 'a.ts'), 'original');
    const pinned = await pinFollowRoot(root);
    if (!pinned) throw new Error('The original fixture root could not be pinned');
    expect(await readFollowFile(pinned, 'a.ts')).toBe('original');
    await rename(root, join(parent, 'previous'));
    await mkdir(root);
    await writeFile(join(root, 'a.ts'), 'replacement');
    expect(await followRootError(root, pinned)).toBe('rootChanged');
    expect(await readFollowFile(pinned, 'a.ts')).toBeUndefined();
  });

  it('rejects a non-regular entry named like a source file', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'maestri-follow-')); temporary.push(parent);
    const root = join(parent, 'project'); await mkdir(root);
    await mkdir(join(root, 'dir.ts'));
    expect(await readFollowFile(root, 'dir.ts')).toBeUndefined();
  });
});
