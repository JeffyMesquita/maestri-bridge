export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const STAGED_LIFETIME_MS = 14 * 60 * 1000;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  zip: 'application/zip',
  log: 'text/plain',
};

const MAX_FILE_NAME_LENGTH = 120;
const FORBIDDEN_FILE_NAME_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]/g;

export function mimeForFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) {
    return 'application/octet-stream';
  }
  const extension = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

export function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith('image/');
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? '';
  const cleaned = base.replace(FORBIDDEN_FILE_NAME_CHARS, '_');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    return 'attachment';
  }
  if (cleaned.length <= MAX_FILE_NAME_LENGTH) {
    return cleaned;
  }

  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? cleaned.slice(dot) : '';
  if (extension.length >= MAX_FILE_NAME_LENGTH) {
    return cleaned.slice(0, MAX_FILE_NAME_LENGTH);
  }
  const stem = cleaned.slice(0, cleaned.length - extension.length);
  return `${stem.slice(0, MAX_FILE_NAME_LENGTH - extension.length)}${extension}`;
}

export function needsRestage(stagedAt: number, now: number): boolean {
  return now - stagedAt > STAGED_LIFETIME_MS;
}
