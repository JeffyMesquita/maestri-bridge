import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WireClient } from '../src/client.ts';
import { WireError } from '../src/errors.ts';
import type { Credentials } from '../src/types.ts';
import { startTestServer } from './helpers/test-server.ts';
import type { TestServer } from './helpers/test-server.ts';

const sample = JSON.parse(
  readFileSync(new URL('./fixtures/wire-sample.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const TOKEN = 'b'.repeat(64);
const servers: TestServer[] = [];

async function start(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<TestServer> {
  const server = await startTestServer(handler);
  servers.push(server);
  return server;
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.close()));
});

function credentialsFor(server: TestServer): Credentials {
  return {
    host: server.host,
    port: server.port,
    pin: server.pin,
    token: TOKEN,
    deviceId: 'device-1',
    deviceName: 'Teste',
    role: 'owner',
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function captureError(promise: Promise<unknown>): Promise<WireError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WireError) {
      return error;
    }
    throw error;
  }
  throw new Error('Esperava um WireError.');
}

function chatSnapshotRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    terminalId: 't1',
    conversationId: 'c1',
    entries: [],
    ...overrides,
  };
}

function chatEntryRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    role: 'user',
    ts: '2026-01-01T00:00:00Z',
    kind: 'message',
    text: 'oi',
    ...overrides,
  };
}

describe('WireClient', () => {
  it('info envia Bearer e devolve o parse', async () => {
    let method = '';
    let url = '';
    let authorization = '';
    const server = await start((req, res) => {
      method = req.method ?? '';
      url = req.url ?? '';
      authorization = req.headers.authorization ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sample.info));
    });

    const info = await new WireClient(credentialsFor(server)).info();

    expect(method).toBe('GET');
    expect(url).toBe('/api/info');
    expect(authorization).toBe(`Bearer ${TOKEN}`);
    expect(info.name).toBe('Studio');
    expect(info.protocolVersion).toBe(1);
    expect(info.capabilities).toContain('feedSnapshots');
  });

  it('rejeita protocolVersion diferente de 1', async () => {
    const server = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'X', protocolVersion: 2, capabilities: [] }));
    });

    const error = await captureError(new WireClient(credentialsFor(server)).info());

    expect(error.code).toBe('protocolMismatch');
    expect(error.message).toBe('Unsupported Maestri protocol version.');
  });

  it('listWorkspaces remove os bloqueados', async () => {
    const server = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sample.workspaces));
    });

    const workspaces = await new WireClient(credentialsFor(server)).listWorkspaces();

    expect(workspaces).toHaveLength(5);
    expect(workspaces.every((workspace) => !workspace.isLocked)).toBe(true);
    expect(workspaces.map((workspace) => workspace.name)).toContain('Maestri Extension');
  });

  it('getFeed codifica o id e envia floor quando informado', async () => {
    const urls: string[] = [];
    const server = await start((req, res) => {
      urls.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sample.feed));
    });
    const client = new WireClient(credentialsFor(server));

    const feed = await client.getFeed('A/B C');
    expect(urls[0]).toBe('/api/workspaces/A%2FB%20C/feed');
    expect(feed.terminals).toHaveLength(4);

    const ground = await client.getFeed('A/B C', 'ground');
    expect(urls[1]).toBe('/api/workspaces/A%2FB%20C/feed?floor=ground');
    expect(ground.floors[0]?.name).toBe('Ground');
  });

  it('sendPrompt envia o texto via POST', async () => {
    let method = '';
    let url = '';
    let body: unknown;
    const server = await start(async (req, res) => {
      method = req.method ?? '';
      url = req.url ?? '';
      body = JSON.parse(await readBody(req));
      res.writeHead(200);
      res.end();
    });

    await new WireClient(credentialsFor(server)).sendPrompt('t/1', 'Olá, agente');

    expect(method).toBe('POST');
    expect(url).toBe('/api/terminals/t%2F1/prompt');
    expect(body).toEqual({ text: 'Olá, agente' });
  });

  it('sendPrompt rejeita texto vazio sem fazer requisição', async () => {
    const server = await start((_req, res) => {
      res.end();
    });

    const error = await captureError(new WireClient(credentialsFor(server)).sendPrompt('t1', '   '));

    expect(error.code).toBe('invalidRequest');
    expect(error.message).toBe('The message is empty.');
    expect(error.messageId).toBe('emptyMessage');
    expect(server.requests).toBe(0);
  });

  it('sendPrompt traduz 409 em conflict', async () => {
    const server = await start((_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'conflict', message: 'Terminal parado.' } }),
      );
    });

    const error = await captureError(
      new WireClient(credentialsFor(server)).sendPrompt('t1', 'Olá'),
    );

    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
    expect(error.message).toBe('This terminal is not running in Maestri.');
    expect(error.messageId).toBe('terminalNotRunning');
    expect(error.cause).toBeInstanceOf(WireError);
    if (error.cause instanceof WireError) {
      expect(error.cause.status).toBe(409);
    }
  });

  it('focusTerminal faz POST no path do terminal', async () => {
    let method = '';
    let url = '';
    const server = await start((req, res) => {
      method = req.method ?? '';
      url = req.url ?? '';
      res.writeHead(200);
      res.end();
    });

    await new WireClient(credentialsFor(server)).focusTerminal('id/1');

    expect(method).toBe('POST');
    expect(url).toBe('/api/terminals/id%2F1/focus');
  });

  it('approve e reject fazem POST sem corpo', async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const server = await start(async (req, res) => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: await readBody(req),
      });
      res.writeHead(200);
      res.end();
    });
    const client = new WireClient(credentialsFor(server));

    await client.approve('t/1');
    await client.reject('t/2');

    expect(requests).toEqual([
      { method: 'POST', url: '/api/terminals/t%2F1/approve', body: '' },
      { method: 'POST', url: '/api/terminals/t%2F2/reject', body: '' },
    ]);
  });

  it('approve traduz 409 em conflict', async () => {
    const server = await start((_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'conflict', message: 'Nada pendente.' } }),
      );
    });

    const error = await captureError(
      new WireClient(credentialsFor(server)).approve('t1'),
    );

    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
    expect(error.message).toBe('This agent is not waiting for an answer.');
    expect(error.cause).toBeInstanceOf(WireError);
    if (error.cause instanceof WireError) {
      expect(error.cause.status).toBe(409);
    }
  });
});

describe('Chat do WireClient', () => {
  it('getChat busca o snapshot do terminal', async () => {
    let method = '';
    let url = '';
    const server = await start((req, res) => {
      method = req.method ?? '';
      url = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(chatSnapshotRaw({ entries: [chatEntryRaw()] })));
    });

    const chat = await new WireClient(credentialsFor(server)).getChat('t/1');

    expect(method).toBe('GET');
    expect(url).toBe('/api/terminals/t%2F1/chat');
    expect(chat.terminalId).toBe('t1');
    expect(chat.entries).toHaveLength(1);
  });

  it('setChatEnabled, selectChatThread e clearChatThread enviam os corpos certos', async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const server = await start(async (req, res) => {
      const text = await readBody(req);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: text === '' ? '' : JSON.parse(text),
      });
      if (req.method === 'DELETE') {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(chatSnapshotRaw()));
    });
    const client = new WireClient(credentialsFor(server));

    const enabled = await client.setChatEnabled('t/1', true);
    const selected = await client.selectChatThread('t/1', 2);
    await client.clearChatThread('t/1', 2);

    expect(requests).toEqual([
      { method: 'PUT', url: '/api/terminals/t%2F1/chat', body: { enabled: true } },
      { method: 'PUT', url: '/api/terminals/t%2F1/chat/thread', body: { slot: 2 } },
      { method: 'DELETE', url: '/api/terminals/t%2F1/chat/thread', body: { slot: 2 } },
    ]);
    expect(enabled.terminalId).toBe('t1');
    expect(selected.terminalId).toBe('t1');
  });

  it('selectChatThread traduz 409 em chatBusy', async () => {
    const server = await start((_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'conflict', message: 'Ocupado.' } }));
    });

    const error = await captureError(
      new WireClient(credentialsFor(server)).selectChatThread('t1', 1),
    );

    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
    expect(error.messageId).toBe('chatBusy');
    expect(error.message).toBe('Maestri is busy with this chat right now.');
    expect(error.cause).toBeInstanceOf(WireError);
  });

  it('getChatThreadPreviews e getChatHistory parseiam as respostas', async () => {
    const urls: string[] = [];
    const server = await start((req, res) => {
      urls.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if ((req.url ?? '').endsWith('/threads')) {
        res.end(
          JSON.stringify({
            threads: [{ id: 0, conversationId: 'c1', entries: [chatEntryRaw()] }],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({ conversationId: 'c1', entries: [chatEntryRaw()] }),
      );
    });
    const client = new WireClient(credentialsFor(server));

    const previews = await client.getChatThreadPreviews('t1');
    const history = await client.getChatHistory('t1');

    expect(urls).toEqual([
      '/api/terminals/t1/chat/threads',
      '/api/terminals/t1/chat/history',
    ]);
    expect(previews[0]?.entries).toHaveLength(1);
    expect(history.entries).toHaveLength(1);
  });

  it('loadOlderChat e markChatRead batem nas rotas e corpos', async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const server = await start(async (req, res) => {
      const text = await readBody(req);
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: text === '' ? '' : JSON.parse(text),
      });
      res.writeHead(200);
      res.end();
    });
    const client = new WireClient(credentialsFor(server));

    await client.loadOlderChat('t/1', 'c1', 'e/1');
    await client.markChatRead('t/1');

    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/api/terminals/t%2F1/chat/history',
        body: { conversationId: 'c1', beforeEntryId: 'e/1' },
      },
      { method: 'POST', url: '/api/terminals/t%2F1/chat/read', body: '' },
    ]);
  });

  it('deleteChatEntry e clearChatHistory usam DELETE nas rotas certas', async () => {
    const requests: string[] = [];
    const server = await start((req, res) => {
      requests.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.writeHead(200);
      res.end();
    });
    const client = new WireClient(credentialsFor(server));

    await client.deleteChatEntry('t/1', 'e/1');
    await client.clearChatHistory('t/1');

    expect(requests).toEqual([
      'DELETE /api/terminals/t%2F1/chat/entries/e%2F1',
      'DELETE /api/terminals/t%2F1/chat/history',
    ]);
  });

  it('downloadChatAttachment devolve os bytes e o content-type', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    let url = '';
    let accept = '';
    const server = await start((req, res) => {
      url = req.url ?? '';
      accept = req.headers.accept ?? '';
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(bytes);
    });

    const result = await new WireClient(credentialsFor(server)).downloadChatAttachment(
      't/1',
      'a/1',
    );

    expect(url).toBe('/api/terminals/t%2F1/chat/attachments/a%2F1');
    expect(accept).toBe('*/*');
    expect(result.body).toEqual(bytes);
    expect(result.contentType).toBe('image/png');
  });

  it('stageAttachment envia o arquivo cru e parseia o anexo', async () => {
    let url = '';
    let contentType = '';
    let body = '';
    const server = await start(async (req, res) => {
      url = req.url ?? '';
      contentType = req.headers['content-type'] ?? '';
      body = await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          attachmentId: 'a1',
          fileName: 'nota final.txt',
          mimeType: 'text/plain',
        }),
      );
    });
    const file = Buffer.from('conteúdo do arquivo');

    const staged = await new WireClient(credentialsFor(server)).stageAttachment(
      't/1',
      'nota final.txt',
      file,
      'text/plain',
    );

    expect(url).toBe('/api/terminals/t%2F1/attachments?filename=nota+final.txt');
    expect(contentType).toBe('text/plain');
    expect(body).toBe(file.toString('utf8'));
    expect(staged).toEqual({
      attachmentId: 'a1',
      fileName: 'nota final.txt',
      mimeType: 'text/plain',
    });
  });

  it('discardAttachment faz DELETE no path do anexo', async () => {
    let method = '';
    let url = '';
    const server = await start((req, res) => {
      method = req.method ?? '';
      url = req.url ?? '';
      res.writeHead(200);
      res.end();
    });

    await new WireClient(credentialsFor(server)).discardAttachment('t/1', 'a/1');

    expect(method).toBe('DELETE');
    expect(url).toBe('/api/terminals/t%2F1/attachments/a%2F1');
  });

  it('sendPromptSegments envia segmentos e clientMessageId', async () => {
    let url = '';
    let body: unknown;
    const server = await start(async (req, res) => {
      url = req.url ?? '';
      body = JSON.parse(await readBody(req));
      res.writeHead(200);
      res.end();
    });

    await new WireClient(credentialsFor(server)).sendPromptSegments(
      't/1',
      [{ text: 'Olá' }, { attachmentId: 'a1' }],
      'client-1',
    );

    expect(url).toBe('/api/terminals/t%2F1/prompt');
    expect(body).toEqual({
      segments: [{ text: 'Olá' }, { attachmentId: 'a1' }],
      clientMessageId: 'client-1',
    });
  });

  it('sendPromptSegments rejeita segmentos vazios sem fazer requisição', async () => {
    const server = await start((_req, res) => {
      res.end();
    });

    const error = await captureError(
      new WireClient(credentialsFor(server)).sendPromptSegments('t1', [{ text: '   ' }]),
    );

    expect(error.code).toBe('invalidRequest');
    expect(error.messageId).toBe('emptyMessage');
    expect(server.requests).toBe(0);
  });

  it('sendPromptSegments traduz 409 em terminalNotRunning', async () => {
    const server = await start((_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'conflict', message: 'Parado.' } }));
    });

    const error = await captureError(
      new WireClient(credentialsFor(server)).sendPromptSegments('t1', [{ text: 'Olá' }]),
    );

    expect(error.code).toBe('conflict');
    expect(error.status).toBe(409);
    expect(error.messageId).toBe('terminalNotRunning');
    expect(error.message).toBe('This terminal is not running in Maestri.');
  });

  it('listMentions e listTerminalFiles parseiam e enviam a query', async () => {
    const urls: string[] = [];
    const server = await start((req, res) => {
      const url = req.url ?? '';
      urls.push(url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url.startsWith('/api/terminals/t1/mentions')) {
        res.end(JSON.stringify({ mentions: [{ kind: 'agent', id: 'a1', name: 'Nina' }] }));
        return;
      }
      res.end(
        JSON.stringify({
          query: 'app',
          root: '/projeto',
          entries: [{ relativePath: 'src/app.ts', name: 'app.ts' }],
          isTruncated: false,
        }),
      );
    });
    const client = new WireClient(credentialsFor(server));

    const mentions = await client.listMentions('t1');
    const files = await client.listTerminalFiles('t1', {
      query: 'app',
      scope: 'src',
      limit: 5,
    });

    expect(urls).toEqual([
      '/api/terminals/t1/mentions',
      '/api/terminals/t1/files?query=app&scope=src&limit=5',
    ]);
    expect(mentions).toEqual([
      {
        kind: 'agent',
        id: 'a1',
        name: 'Nina',
        isOnActiveFloor: false,
        sectionOrder: 0,
        order: 0,
        depth: 0,
      },
    ]);
    expect(files.entries).toEqual([
      { relativePath: 'src/app.ts', name: 'app.ts', isDirectory: false },
    ]);
  });

  it('listSavedPrompts busca GET /api/prompts', async () => {
    const urls: string[] = [];
    const server = await start((req, res) => {
      urls.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          prompts: [{ id: 'p1', name: 'Resumo', text: 'Resuma o diff' }],
        }),
      );
    });
    const client = new WireClient(credentialsFor(server));

    const prompts = await client.listSavedPrompts();

    expect(urls).toEqual(['/api/prompts']);
    expect(prompts).toEqual([{ id: 'p1', name: 'Resumo', text: 'Resuma o diff' }]);
  });
});
