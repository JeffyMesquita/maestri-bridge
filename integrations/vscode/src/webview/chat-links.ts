export interface FileReference {
  start: number;
  end: number;
  path: string;
  line?: number;
  endLine?: number;
}

const SEGMENT = '[A-Za-z0-9_@-](?:[A-Za-z0-9_.@-]*[A-Za-z0-9_@-])?';
const SLASH_PATH = `(?:\\.{1,2}\\/)?(?:${SEGMENT}\\/)+${SEGMENT}`;
const BARE_FILE = `[A-Za-z0-9_@-](?:[A-Za-z0-9_.@-]*[A-Za-z0-9_@-])?\\.[A-Za-z0-9]{1,8}`;
const SUFFIX = '(?::(\\d+)(?:-(\\d+))?|#L(\\d+)(?:-L(\\d+))?)?';
const REFERENCE_PATTERN = new RegExp(
  `(?<![\\w./@-])(${SLASH_PATH}|${BARE_FILE})${SUFFIX}(?![\\w/@-])`,
  'g',
);

export function findFileReferences(text: string): FileReference[] {
  const references: FileReference[] = [];
  REFERENCE_PATTERN.lastIndex = 0;

  let match = REFERENCE_PATTERN.exec(text);
  while (match !== null) {
    const path = match[1] ?? '';
    const rawStart = match[2] ?? match[4];
    const rawEnd = match[3] ?? match[5];
    const line = rawStart === undefined ? undefined : Number(rawStart);
    const endLine = rawEnd === undefined ? undefined : Number(rawEnd);

    if (path !== '' && isFileReference(path, line, endLine)) {
      const reference: FileReference = {
        start: match.index,
        end: match.index + match[0].length,
        path,
      };
      if (line !== undefined) {
        reference.line = line;
        if (endLine !== undefined) {
          reference.endLine = endLine;
        }
      }
      references.push(reference);
    }

    match = REFERENCE_PATTERN.exec(text);
  }

  return references;
}

function isFileReference(
  path: string,
  line: number | undefined,
  endLine: number | undefined,
): boolean {
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
    return false;
  }
  if (endLine !== undefined && (line === undefined || !Number.isInteger(endLine) || endLine < line)) {
    return false;
  }

  const basename = path.slice(path.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  if (dot !== -1) {
    const extension = basename.slice(dot + 1);
    if (!/^[A-Za-z0-9]{1,8}$/.test(extension)) {
      return false;
    }
  } else if (!path.includes('/')) {
    return false;
  }

  if (!path.includes('/') && line === undefined) {
    return false;
  }

  return !path.startsWith('http://') && !path.startsWith('https://');
}
