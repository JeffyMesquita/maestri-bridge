import { WireError } from './errors.ts';

export interface SavedPrompt {
  id: string;
  name: string;
  description?: string;
  text: string;
  workspaceId?: string;
}

export function parseSavedPrompts(raw: unknown): SavedPrompt[] {
  let items: readonly unknown[];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (isRecord(raw)) {
    if (Array.isArray(raw.prompts)) {
      items = raw.prompts;
    } else if (Array.isArray(raw.savedPrompts)) {
      items = raw.savedPrompts;
    } else {
      throw invalidResponse();
    }
  } else {
    throw invalidResponse();
  }

  const prompts: SavedPrompt[] = [];
  for (const item of items) {
    const prompt = parsePrompt(item);
    if (prompt !== undefined) {
      prompts.push(prompt);
    }
  }
  return prompts;
}

function parsePrompt(raw: unknown): SavedPrompt | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const text = firstNonEmpty(raw.text, raw.body, raw.prompt, raw.content);
  if (text === undefined) {
    return undefined;
  }

  const idCandidate = firstNonEmpty(raw.id, raw.path);
  const nameCandidate = firstNonEmpty(raw.name, raw.title);
  const name = nameCandidate ?? idCandidate;
  const id = idCandidate ?? nameCandidate;
  if (id === undefined || name === undefined) {
    return undefined;
  }

  const prompt: SavedPrompt = { id, name, text };
  const description = firstNonEmpty(raw.description);
  if (description !== undefined) {
    prompt.description = description;
  }
  const workspaceId = firstNonEmpty(raw.workspaceId);
  if (workspaceId !== undefined) {
    prompt.workspaceId = workspaceId;
  }
  return prompt;
}

function firstNonEmpty(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
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
