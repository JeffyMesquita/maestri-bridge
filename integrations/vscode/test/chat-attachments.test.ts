import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  STAGED_LIFETIME_MS,
  isImageMime,
  mimeForFileName,
  needsRestage,
  safeFileName,
} from '../src/chat-attachments.ts';

describe('mimeForFileName', () => {
  it('mapeia as extensões conhecidas', () => {
    expect(mimeForFileName('a.png')).toBe('image/png');
    expect(mimeForFileName('a.jpg')).toBe('image/jpeg');
    expect(mimeForFileName('a.jpeg')).toBe('image/jpeg');
    expect(mimeForFileName('a.gif')).toBe('image/gif');
    expect(mimeForFileName('a.webp')).toBe('image/webp');
    expect(mimeForFileName('a.heic')).toBe('image/heic');
    expect(mimeForFileName('a.svg')).toBe('image/svg+xml');
    expect(mimeForFileName('a.pdf')).toBe('application/pdf');
    expect(mimeForFileName('a.txt')).toBe('text/plain');
    expect(mimeForFileName('a.md')).toBe('text/markdown');
    expect(mimeForFileName('a.json')).toBe('application/json');
    expect(mimeForFileName('a.csv')).toBe('text/csv');
    expect(mimeForFileName('a.zip')).toBe('application/zip');
    expect(mimeForFileName('a.log')).toBe('text/plain');
  });

  it('ignora a caixa da extensão', () => {
    expect(mimeForFileName('FOTO.PNG')).toBe('image/png');
  });

  it('usa octet-stream para extensões desconhecidas ou ausentes', () => {
    expect(mimeForFileName('a.bin')).toBe('application/octet-stream');
    expect(mimeForFileName('Makefile')).toBe('application/octet-stream');
    expect(mimeForFileName('a.')).toBe('application/octet-stream');
  });
});

describe('isImageMime', () => {
  it('reconhece image/', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('IMAGE/WEBP')).toBe(true);
    expect(isImageMime('application/pdf')).toBe(false);
  });
});

describe('safeFileName', () => {
  it('mantém apenas o nome base', () => {
    expect(safeFileName('/tmp/pasta/foto.png')).toBe('foto.png');
    expect(safeFileName('C:\\Users\\ana\\nota.txt')).toBe('nota.txt');
  });

  it('troca caracteres proibidos no nome do anexo e mantém a extensão', () => {
    expect(safeFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
  });

  it('troca caracteres de controle', () => {
    expect(safeFileName(`a${String.fromCharCode(1)}b${String.fromCharCode(31)}c.png`)).toBe(
      'a_b_c.png',
    );
  });

  it('corta nomes longos preservando a extensão', () => {
    const result = safeFileName(`${'a'.repeat(200)}.png`);
    expect(result).toHaveLength(120);
    expect(result.endsWith('.png')).toBe(true);
  });

  it('mantém nomes com até 120 caracteres', () => {
    const name = 'a'.repeat(116) + '.txt';
    expect(safeFileName(name)).toBe(name);
    expect(safeFileName(`${'b'.repeat(120)}`)).toHaveLength(120);
  });

  it('usa attachment quando o nome fica vazio', () => {
    expect(safeFileName('')).toBe('attachment');
    expect(safeFileName('/')).toBe('attachment');
    expect(safeFileName('pasta/')).toBe('attachment');
    expect(safeFileName('.')).toBe('attachment');
    expect(safeFileName('..')).toBe('attachment');
  });
});

describe('needsRestage', () => {
  it('pede novo stage só depois do prazo', () => {
    expect(needsRestage(0, STAGED_LIFETIME_MS)).toBe(false);
    expect(needsRestage(0, STAGED_LIFETIME_MS + 1)).toBe(true);
  });

  it('expõe os limites esperados', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(8 * 1024 * 1024);
    expect(STAGED_LIFETIME_MS).toBe(14 * 60 * 1000);
  });
});
