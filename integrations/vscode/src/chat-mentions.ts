import type { ChatMention, SavedPrompt, TerminalFileEntry } from '@maestri-bridge/core';
import type { MentionView } from './chat-protocol.ts';

const MAX_CATALOG_MENTIONS = 40;
const MAX_FILE_MENTIONS = 20;
const MAX_PROMPT_MENTIONS = 20;

const DETAIL_KINDS = new Set<MentionView['kind']>(['agent', 'note', 'portal']);
const AGENT_VIEW_KINDS = new Set(['agent', 'maestro']);

export function mentionToken(mention: ChatMention): string | undefined {
  const name = attr(mention.name);
  switch (mention.kind) {
    case 'agent':
      return `<maestri-canvas-agent name="${name}" skill="maestri" />`;
    case 'note':
      return `<maestri-canvas-note name="${name}" skill="maestri" />`;
    case 'portal':
      return `<maestri-canvas-portal name="${name}" skill="maestri" />`;
    case 'floor':
      return `<maestri-floor name="${name}" skill="maestri-manager" />`;
    case 'maestro':
      return '<maestri-maestro skill="maestri-manager" />';
    case 'createNote':
      return '<maestri-create-note skill="maestri" />';
    case 'createPortal':
      return '<maestri-create-portal skill="maestri-portal" />';
    case 'createDevicePortal':
      return '<maestri-create-device-portal skill="maestri-portal-devices" />';
    case 'createFloor':
      return '<maestri-create-floor skill="maestri-workspace" />';
    case 'notifications':
      return '<maestri-notifications skill="maestri" />';
    case 'routines':
      return '<maestri-routines skill="maestri-routines" />';
    case 'workspaces':
      return '<maestri-workspaces skill="maestri-workspace" />';
    case 'computerUse':
      return '<maestri-computer-use skill="maestri-computer" />';
    default:
      return undefined;
  }
}

export function catalogMentionViews(
  mentions: readonly ChatMention[],
  query: string,
): MentionView[] {
  const needle = query.trim().toLowerCase();
  return mentions
    .filter((mention) => matchesQuery(mention, needle))
    .filter((mention) => mentionToken(mention) !== undefined)
    .sort(compareMentions)
    .slice(0, MAX_CATALOG_MENTIONS)
    .map(mentionView);
}

export function savedPromptViews(
  prompts: readonly SavedPrompt[],
  query: string,
  workspaceId: string,
): MentionView[] {
  const needle = query.trim().toLowerCase();
  return prompts
    .filter(
      (prompt) => prompt.workspaceId === undefined || prompt.workspaceId === workspaceId,
    )
    .filter((prompt) => matchesPrompt(prompt, needle))
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_PROMPT_MENTIONS)
    .map((prompt) => {
      const view: MentionView = {
        kind: 'prompt',
        label: prompt.name,
        section: 'prompts',
        insertText: prompt.text,
      };
      if (prompt.description !== undefined) {
        view.detail = prompt.description;
      }
      return view;
    });
}

export function fileMentionViews(entries: readonly TerminalFileEntry[]): MentionView[] {
  return entries
    .filter((entry) => !entry.isDirectory)
    .slice(0, MAX_FILE_MENTIONS)
    .map((entry) => ({
      kind: 'file',
      label: entry.name,
      detail: entry.relativePath,
      section: 'files',
      insertText: `@${entry.relativePath}`,
    }));
}

function mentionView(mention: ChatMention): MentionView {
  const token = mentionToken(mention);
  const kind = viewKind(mention.kind);
  const view: MentionView = {
    kind,
    label: mention.name,
    insertText: `@${mention.name}`,
  };
  if (mention.section !== undefined) {
    view.section = mention.section;
  }
  if (token !== undefined) {
    view.token = token;
  }
  if (mention.floorName !== undefined && DETAIL_KINDS.has(kind)) {
    view.detail = mention.floorName;
  }
  return view;
}

function viewKind(kind: string): MentionView['kind'] {
  if (AGENT_VIEW_KINDS.has(kind)) {
    return 'agent';
  }
  if (kind === 'note') {
    return 'note';
  }
  if (kind === 'portal') {
    return 'portal';
  }
  if (kind === 'floor') {
    return 'floor';
  }
  return 'action';
}

function matchesPrompt(prompt: SavedPrompt, needle: string): boolean {
  if (needle === '') {
    return true;
  }
  if (prompt.name.toLowerCase().includes(needle)) {
    return true;
  }
  return prompt.description !== undefined && prompt.description.toLowerCase().includes(needle);
}

function matchesQuery(mention: ChatMention, needle: string): boolean {
  if (needle === '') {
    return true;
  }
  if (mention.name.toLowerCase().includes(needle)) {
    return true;
  }
  return mention.tokenName !== undefined && mention.tokenName.toLowerCase().includes(needle);
}

function compareMentions(left: ChatMention, right: ChatMention): number {
  if (left.sectionOrder !== right.sectionOrder) {
    return left.sectionOrder - right.sectionOrder;
  }
  const floor = Number(right.isOnActiveFloor) - Number(left.isOnActiveFloor);
  if (floor !== 0) {
    return floor;
  }
  return left.order - right.order;
}

function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
