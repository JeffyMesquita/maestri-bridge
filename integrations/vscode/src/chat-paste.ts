export function normalizePastedCode(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimEnd();
}

export function isCodeFromSelection(
  pasted: string,
  selections: readonly string[],
): boolean {
  const normalized = normalizePastedCode(pasted);
  if (!normalized.includes('\n')) {
    return false;
  }

  const stripped = stripCommonIndent(normalized);
  return selections.some((selection) => {
    const candidate = normalizePastedCode(selection);
    return candidate === normalized || stripCommonIndent(candidate) === stripped;
  });
}

function stripCommonIndent(text: string): string {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((line) => line.trim() !== '');
  if (nonEmpty.length === 0) {
    return text;
  }

  let indent = leadingWhitespace(nonEmpty[0] ?? '');
  for (const line of nonEmpty.slice(1)) {
    const leading = leadingWhitespace(line);
    while (indent !== '' && !leading.startsWith(indent)) {
      indent = indent.slice(0, -1);
    }
  }

  if (indent === '') {
    return text;
  }

  return lines
    .map((line) =>
      line.startsWith(indent) ? line.slice(indent.length) : line.replace(/^[ \t]*/, ''),
    )
    .join('\n');
}

function leadingWhitespace(line: string): string {
  const match = /^[ \t]*/.exec(line);
  return match?.[0] ?? '';
}
