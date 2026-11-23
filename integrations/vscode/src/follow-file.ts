import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const FOLLOW_FILE_LIMIT_BYTES = 1024 * 1024;

const MAX_FOLLOW_PATH = 1024;

const OPEN_FLAGS = (() => {
  let flags = constants.O_RDONLY;
  if (process.platform !== 'win32') {
    if (typeof constants.O_NONBLOCK === 'number') flags |= constants.O_NONBLOCK;
    if (typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW;
  }
  return flags;
})();

const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', 'coverage', '.next', '.cache', '__pycache__',
  '.maestri', '.codex', '.claude', '.opencode',
]);

const BINARY_EXTENSION = /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|mp4|mov|webm|mkv|mp3|wav|flac|ogg|zip|gz|7z|rar|tar|pdf|exe|dll|so|dylib|woff2?|ttf|otf|wasm|vsix)$/i;

export function isSafeFollowPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FOLLOW_PATH) return false;
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes('\\') || value.includes(':')) return false;
  if (value.startsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function isFollowPathIgnored(file: string): boolean {
  return file.split('/').some((part) => IGNORED_DIRECTORIES.has(part.toLowerCase()));
}

export function isFollowFileAllowed(file: string): boolean {
  return isSafeFollowPath(file) && !BINARY_EXTENSION.test(file) && !isFollowPathIgnored(file) && !file.split('/').some((part) =>
    /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?)$/i.test(part) ||
    /\.(?:pem|key|p12|pfx)$/i.test(part),
  );
}

export interface FollowRoot {
  path: string;
  dev: bigint;
  ino: bigint;
}

export async function pinFollowRoot(path: string): Promise<FollowRoot | undefined> {
  try {
    const physical = await realpath(path);
    const info = await lstat(physical, { bigint: true });
    if (!info.isDirectory()) return undefined;
    const root = { path: physical, dev: info.dev, ino: info.ino };
    return await followRootError(path, root) ? undefined : root;
  } catch {
    return undefined;
  }
}

async function samePhysicalRoot(root: FollowRoot): Promise<boolean> {
  const current = await lstat(root.path, { bigint: true });
  return current.isDirectory() && current.dev === root.dev && current.ino === root.ino;
}

export async function followRootError(
  path: string,
  root: FollowRoot,
): Promise<'rootChanged' | 'rootUnavailable' | undefined> {
  try {
    if (relative(root.path, await realpath(path)) !== '') return 'rootChanged';
    return await samePhysicalRoot(root) ? undefined : 'rootChanged';
  } catch {
    return 'rootUnavailable';
  }
}

async function resolveWithinRoot(root: FollowRoot, file: string): Promise<string | undefined> {
  if (!isFollowFileAllowed(file)) return undefined;
  try {
    if (!(await samePhysicalRoot(root))) return undefined;
    const candidate = resolve(root.path, file);
    const physicalFile = await realpath(candidate);
    if (relative(candidate, physicalFile) !== '') return undefined;
    const within = relative(root.path, physicalFile);
    if (within === '' || within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)) {
      return undefined;
    }
    const info = await lstat(physicalFile);
    return info.isFile() && info.size <= FOLLOW_FILE_LIMIT_BYTES ? physicalFile : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveFollowFile(path: string, file: string): Promise<string | undefined> {
  if (!isFollowFileAllowed(file)) return undefined;
  const root = await pinFollowRoot(path);
  return root && await resolveWithinRoot(root, file);
}

export async function readFollowFile(path: string | FollowRoot, file: string): Promise<string | undefined> {
  if (!isFollowFileAllowed(file)) return undefined;
  const root = typeof path === 'string' ? await pinFollowRoot(path) : path;
  if (root === undefined) return undefined;
  const physical = await resolveWithinRoot(root, file);
  if (physical === undefined) return undefined;
  try {
    const handle = await open(physical, OPEN_FLAGS);
    try {
      const current = await lstat(physical, { bigint: true });
      const opened = await handle.stat({ bigint: true });
      if (!current.isFile() || !opened.isFile() || opened.size > BigInt(FOLLOW_FILE_LIMIT_BYTES) ||
        current.ino !== opened.ino || current.dev !== opened.dev ||
        relative(physical, await realpath(physical)) !== '' || !(await samePhysicalRoot(root))) return undefined;
      const size = Number(opened.size);
      const buffer = Buffer.alloc(size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const completed = await handle.stat({ bigint: true });
      if (length !== size || completed.size !== opened.size || completed.mtimeNs !== opened.mtimeNs ||
        completed.ctimeNs !== opened.ctimeNs || !(await samePhysicalRoot(root))) return undefined;
      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) return undefined;
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function normalizeLines(text: string): string[] {
  return text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
}

export function followLineDelta(previous: string | undefined, next: string | undefined): number {
  if (previous === undefined || next === undefined) return 0;
  const before = normalizeLines(previous);
  const after = normalizeLines(next);
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if (before[index] !== after[index]) return index;
  }
  return 0;
}
