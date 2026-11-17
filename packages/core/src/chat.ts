import { WireError } from './errors.ts';

export type ChatStatus =
  | 'idle'
  | 'working'
  | 'needsAttention'
  | 'notRunning'
  | 'unloaded'
  | (string & {});

export type ChatEntryKind = 'message' | 'progress' | 'final' | 'divider';

export interface ChatAttachmentRef {
  id: string;
  isImage: boolean;
  filename: string;
  contentType?: string;
}

export type ChatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; attachment: ChatAttachmentRef };

export interface ChatEntry {
  id: string;
  role: 'user' | 'agent';
  ts: string;
  kind: ChatEntryKind;
  text: string;
  segments: ChatSegment[];
  authorName?: string;
  agentType?: string;
  clientMessageId?: string;
}

export type ChatThreadColor =
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'graphite'
  | (string & {});

export interface ChatThreadSlot {
  id: number;
  color: ChatThreadColor;
  hasMessages: boolean;
}

export interface ChatThreads {
  activeSlot: number;
  canSelect: boolean;
  items: ChatThreadSlot[];
}

export interface ChatSnapshot {
  terminalId: string;
  conversationId: string;
  enabled: boolean;
  status: ChatStatus;
  entries: ChatEntry[];
  unreadCount: number;
  canClear: boolean;
  talkingToAgentName?: string;
  answeringAgentName?: string;
  threads?: ChatThreads;
  turnInterrupted?: boolean;
  hasOlderOnRecord?: boolean;
}

export interface ChatThreadPreview {
  id: number;
  conversationId: string;
  entries: ChatEntry[];
}

export interface ChatHistory {
  conversationId: string;
  entries: ChatEntry[];
}

export interface StagedAttachment {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  expiresAt?: string;
}

export interface ChatMention {
  kind: string;
  id: string;
  name: string;
  tokenName?: string;
  floorName?: string;
  isOnActiveFloor: boolean;
  section?: string;
  sectionOrder: number;
  order: number;
  depth: number;
}

export interface TerminalFileEntry {
  relativePath: string;
  name: string;
  isDirectory: boolean;
}

export interface TerminalFileIndex {
  query: string;
  root: string;
  entries: TerminalFileEntry[];
  isTruncated: boolean;
}

export type PromptSegment = { text: string } | { attachmentId: string };

export function parseChatSnapshot(raw: unknown): ChatSnapshot {
  if (!isRecord(raw)) {
    throw invalidResponse();
  }

  const terminalId = optionalString(raw.terminalId);
  const conversationId = optionalString(raw.conversationId);
  if (terminalId === undefined || conversationId === undefined || !Array.isArray(raw.entries)) {
    throw invalidResponse();
  }

  const snapshot: ChatSnapshot = {
    terminalId,
    conversationId,
    enabled: optionalBoolean(raw.enabled) ?? false,
    status: optionalString(raw.status) ?? 'idle',
    entries: parseEntries(raw.entries),
    unreadCount: optionalNumber(raw.unreadCount) ?? 0,
    canClear: optionalBoolean(raw.canClear) ?? false,
  };

  const talkingToAgentName = optionalString(raw.talkingToAgentName);
  if (talkingToAgentName !== undefined) {
    snapshot.talkingToAgentName = talkingToAgentName;
  }
  const answeringAgentName = optionalString(raw.answeringAgentName);
  if (answeringAgentName !== undefined) {
    snapshot.answeringAgentName = answeringAgentName;
  }
  const threads = parseThreads(raw.threads);
  if (threads !== undefined) {
    snapshot.threads = threads;
  }
  const turnInterrupted = optionalBoolean(raw.turnInterrupted);
  if (turnInterrupted !== undefined) {
    snapshot.turnInterrupted = turnInterrupted;
  }
  const hasOlderOnRecord = optionalBoolean(raw.hasOlderOnRecord);
  if (hasOlderOnRecord !== undefined) {
    snapshot.hasOlderOnRecord = hasOlderOnRecord;
  }

  return snapshot;
}

export function parseChatEntry(raw: unknown): ChatEntry | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const kind = parseEntryKind(raw.kind);
  if (kind === undefined) {
    return undefined;
  }
  const role = raw.role;
  if (role !== 'user' && role !== 'agent') {
    return undefined;
  }

  const ts = parseTimestamp(raw.ts);
  if (ts === undefined) {
    return undefined;
  }

  const rawId = optionalString(raw.id);
  const id = rawId ?? (kind === 'divider' ? `divider-${ts}` : undefined);
  if (id === undefined) {
    return undefined;
  }

  let authorName = optionalString(raw.authorName);
  let agentType = optionalString(raw.agentType);
  if (isRecord(raw.author)) {
    authorName ??= optionalString(raw.author.name);
    agentType ??= optionalString(raw.author.agentType);
  }

  const entry: ChatEntry = {
    id,
    role,
    ts,
    kind,
    text: optionalString(raw.text) ?? '',
    segments: parseSegments(raw.segments),
  };
  if (authorName !== undefined) {
    entry.authorName = authorName;
  }
  if (agentType !== undefined) {
    entry.agentType = agentType;
  }
  const clientMessageId = optionalString(raw.clientMessageId);
  if (clientMessageId !== undefined) {
    entry.clientMessageId = clientMessageId;
  }

  return entry;
}

export function parseChatThreadPreviews(raw: unknown): ChatThreadPreview[] {
  if (!isRecord(raw) || !Array.isArray(raw.threads)) {
    throw invalidResponse();
  }

  const previews: ChatThreadPreview[] = [];
  for (const item of raw.threads) {
    if (!isRecord(item)) {
      continue;
    }
    const id = optionalNumber(item.id);
    const conversationId = optionalString(item.conversationId);
    if (id === undefined || conversationId === undefined) {
      continue;
    }
    previews.push({
      id,
      conversationId,
      entries: parseEntries(Array.isArray(item.entries) ? item.entries : []),
    });
  }
  return previews;
}

export function parseChatHistory(raw: unknown): ChatHistory {
  if (!isRecord(raw)) {
    throw invalidResponse();
  }
  const conversationId = optionalString(raw.conversationId);
  if (conversationId === undefined || !Array.isArray(raw.entries)) {
    throw invalidResponse();
  }
  return {
    conversationId,
    entries: parseEntries(raw.entries),
  };
}

export function parseStagedAttachment(raw: unknown): StagedAttachment {
  if (!isRecord(raw)) {
    throw invalidResponse();
  }
  const attachmentId = optionalString(raw.attachmentId);
  const fileName = optionalString(raw.fileName);
  const mimeType = optionalString(raw.mimeType);
  if (attachmentId === undefined || fileName === undefined || mimeType === undefined) {
    throw invalidResponse();
  }

  const staged: StagedAttachment = { attachmentId, fileName, mimeType };
  const expiresAt = optionalString(raw.expiresAt);
  if (expiresAt !== undefined) {
    staged.expiresAt = expiresAt;
  }
  return staged;
}

export function parseMentions(raw: unknown): ChatMention[] {
  if (!isRecord(raw) || !Array.isArray(raw.mentions)) {
    throw invalidResponse();
  }

  const mentions: ChatMention[] = [];
  for (const item of raw.mentions) {
    if (!isRecord(item)) {
      continue;
    }
    const kind = optionalString(item.kind);
    const id = optionalString(item.id);
    const name = optionalString(item.name);
    if (kind === undefined || id === undefined || name === undefined) {
      continue;
    }

    const mention: ChatMention = {
      kind,
      id,
      name,
      isOnActiveFloor: optionalBoolean(item.isOnActiveFloor) ?? false,
      sectionOrder: optionalNumber(item.sectionOrder) ?? 0,
      order: optionalNumber(item.order) ?? 0,
      depth: optionalNumber(item.depth) ?? 0,
    };
    const tokenName = optionalString(item.tokenName);
    if (tokenName !== undefined) {
      mention.tokenName = tokenName;
    }
    const floorName = optionalString(item.floorName);
    if (floorName !== undefined) {
      mention.floorName = floorName;
    }
    const section = optionalString(item.section);
    if (section !== undefined) {
      mention.section = section;
    }
    mentions.push(mention);
  }
  return mentions;
}

export function parseTerminalFileIndex(raw: unknown): TerminalFileIndex {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) {
    throw invalidResponse();
  }

  const entries: TerminalFileEntry[] = [];
  for (const item of raw.entries) {
    if (!isRecord(item)) {
      continue;
    }
    const relativePath = optionalString(item.relativePath);
    const name = optionalString(item.name);
    if (relativePath === undefined || name === undefined) {
      continue;
    }
    entries.push({
      relativePath,
      name,
      isDirectory: optionalBoolean(item.isDirectory) ?? false,
    });
  }

  return {
    query: optionalString(raw.query) ?? '',
    root: optionalString(raw.root) ?? '',
    entries,
    isTruncated: optionalBoolean(raw.isTruncated) ?? false,
  };
}

function parseEntries(items: readonly unknown[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  for (const item of items) {
    const entry = parseChatEntry(item);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return entries;
}

function parseSegments(raw: unknown): ChatSegment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const segments: ChatSegment[] = [];
  for (const item of raw) {
    const segment = parseSegment(item);
    if (segment !== undefined) {
      segments.push(segment);
    }
  }
  return segments;
}

function parseSegment(raw: unknown): ChatSegment | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  if (raw.type === 'text') {
    const text = optionalString(raw.text);
    return text === undefined ? undefined : { kind: 'text', text };
  }
  if (raw.type === 'attachment') {
    const attachment = parseAttachmentRef(raw);
    return attachment === undefined ? undefined : { kind: 'attachment', attachment };
  }
  if (raw.type !== undefined) {
    return undefined;
  }

  if (isRecord(raw.attachment)) {
    const attachment = parseAttachmentRef(raw.attachment);
    return attachment === undefined ? undefined : { kind: 'attachment', attachment };
  }

  const text = optionalString(raw.text);
  return text === undefined ? undefined : { kind: 'text', text };
}

function parseAttachmentRef(raw: unknown): ChatAttachmentRef | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = optionalString(raw.id);
  const isImage = optionalBoolean(raw.isImage);
  const filename = optionalString(raw.filename);
  if (id === undefined || isImage === undefined || filename === undefined) {
    return undefined;
  }

  const attachment: ChatAttachmentRef = { id, isImage, filename };
  const contentType = optionalString(raw.contentType);
  if (contentType !== undefined) {
    attachment.contentType = contentType;
  }
  return attachment;
}

function parseThreads(raw: unknown): ChatThreads | undefined {
  if (!isRecord(raw) || typeof raw.activeSlot !== 'number' || !Array.isArray(raw.items)) {
    return undefined;
  }

  const items: ChatThreadSlot[] = [];
  for (const item of raw.items) {
    if (!isRecord(item)) {
      continue;
    }
    const id = optionalNumber(item.id);
    if (id === undefined || !Number.isInteger(id) || id < 0 || id > 6) {
      continue;
    }
    const color = optionalString(item.color);
    if (color === undefined) {
      continue;
    }
    items.push({ id, color, hasMessages: optionalBoolean(item.hasMessages) ?? false });
  }

  return {
    activeSlot: raw.activeSlot,
    canSelect: optionalBoolean(raw.canSelect) ?? false,
    items,
  };
}

function parseEntryKind(value: unknown): ChatEntryKind | undefined {
  return value === 'message' || value === 'progress' || value === 'final' || value === 'divider'
    ? value
    : undefined;
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  let milliseconds: number;
  if (value > 1e12) {
    milliseconds = value;
  } else if (value > 1e9) {
    milliseconds = value * 1000;
  } else {
    milliseconds = Date.UTC(2001, 0, 1) + value * 1000;
  }

  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function invalidResponse(): WireError {
  return new WireError({
    code: 'unknown',
    message: 'Invalid response from Maestri.',
    messageId: 'invalidResponse',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
