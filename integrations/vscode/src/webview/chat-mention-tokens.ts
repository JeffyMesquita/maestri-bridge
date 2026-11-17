export interface InsertedMention {
  text: string;
  token: string;
}

export type MentionTriggerChar = '@' | '$';

export interface MentionTrigger {
  trigger: MentionTriggerChar;
  start: number;
  query: string;
}

const MENTION_TAG_PATTERN = /<maestri-([a-z0-9-]+)([^>]*?)\/>/gi;
const ATTRIBUTE_PATTERN = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function findMentionTrigger(
  value: string,
  caret: number,
): MentionTrigger | undefined {
  const end = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, end);

  for (let index = before.length - 1; index >= 0; index -= 1) {
    const character = before.charAt(index);
    if (character !== '@' && character !== '$') {
      continue;
    }
    if (index > 0 && !/\s/.test(before.charAt(index - 1))) {
      continue;
    }
    const query = before.slice(index + 1);
    if (/\s/.test(query)) {
      continue;
    }
    return { trigger: character, start: index, query };
  }

  return undefined;
}

export function serializeMentions(
  message: string,
  inserted: readonly InsertedMention[],
): string {
  let result = message;
  const sorted = [...inserted]
    .filter((mention) => mention.text !== '')
    .sort((a, b) => b.text.length - a.text.length);

  for (const mention of sorted) {
    const pattern = new RegExp(`${escapeRegExp(mention.text)}(?![\\p{L}\\p{N}])`, 'gu');
    result = result.replace(pattern, () => mention.token);
  }

  return result;
}

export function displayMentionTokens(
  text: string,
  actionLabel: (kind: string) => string | undefined,
): string {
  return text.replace(
    MENTION_TAG_PATTERN,
    (match: string, rawKind: string, rawAttributes: string) => {
      const attributes = parseAttributes(rawAttributes);
      const name = attributes.get('name');
      if (name !== undefined && name !== '') {
        return `@${decodeEntities(name)}`;
      }

      const label = actionLabel(toCamelCase(rawKind));
      return label === undefined ? match : `@${label}`;
    },
  );
}

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match = ATTRIBUTE_PATTERN.exec(raw);
  while (match !== null) {
    const key = match[1];
    if (key !== undefined) {
      attributes.set(key.toLowerCase(), match[2] ?? match[3] ?? '');
    }
    match = ATTRIBUTE_PATTERN.exec(raw);
  }
  return attributes;
}

function toCamelCase(kind: string): string {
  return kind
    .toLowerCase()
    .replace(/-([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function decodeEntities(value: string): string {
  return value.replace(/&(amp|quot|lt|gt);/g, (match: string, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      default:
        return match;
    }
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
