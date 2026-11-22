import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const FOLLOW_FILE_LIMIT_BYTES = 1024 * 1024;

const MAX_FOLLOW_PATH = 1024;

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

export async function resolveFollowFile(root: string, file: string): Promise<string | undefined> {
  if (!isFollowFileAllowed(file)) return undefined;
  try {
    const physicalRoot = await realpath(root);
    const candidate = resolve(physicalRoot, file);
    const physicalFile = await realpath(candidate);
    if (relative(candidate, physicalFile) !== '') return undefined;
    const within = relative(physicalRoot, physicalFile);
    if (within === '' || within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)) {
      return undefined;
    }
    const info = await lstat(physicalFile);
    return info.isFile() && info.size <= FOLLOW_FILE_LIMIT_BYTES ? physicalFile : undefined;
  } catch {
    return undefined;
  }
}

export async function readFollowFile(root: string, file: string): Promise<string | undefined> {
  const physical = await resolveFollowFile(root, file);
  if (physical === undefined) return undefined;
  try {
    const handle = await open(physical, 'r');
    try {
      const current = await lstat(physical);
      const opened = await handle.stat();
      if (!current.isFile() || !opened.isFile() || opened.size > FOLLOW_FILE_LIMIT_BYTES ||
        current.ino !== opened.ino || current.dev !== opened.dev ||
        relative(physical, await realpath(physical)) !== '') return undefined;
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const completed = await handle.stat();
      if (length !== opened.size || completed.size !== opened.size ||
        completed.mtimeMs !== opened.mtimeMs || completed.ctimeMs !== opened.ctimeMs) return undefined;
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
