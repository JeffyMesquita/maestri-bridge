import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { buildEvent, buildActivityUri, openUri } from '../../../../skills/maestri-bridge/scripts/emit-activity.mjs';

const contextFile = process.argv[2];
if (!contextFile) throw new Error('Usage: node run-demo.mjs <local-context.json>');
const context = JSON.parse(readFileSync(contextFile, 'utf8'));
const folder = dirname(fileURLToPath(import.meta.url));
const source = resolve(folder, 'shipping-total.mjs');
const test = resolve(folder, 'shipping-total.test.mjs');
const started = Date.now();
const events = [];
let sequence = context.firstSequence ?? 1;

function publish(kind, file, lines, message) {
  const args = [kind];
  if (file) args.push(`${relative(context.root, file).replaceAll('\\', '/')}:${lines}`);
  if (message) args.push(message);
  args.push('--session', context.sessionId, '--agent', context.agentId, '--root', context.root,
    '--seq', String(sequence++), '--editor-path', context.editorPath, '--uri-base', context.uriBase);
  const { event } = buildEvent(args);
  openUri(buildActivityUri(event, { base: context.uriBase }), context.editorPath);
  events.push({ elapsedMs: Date.now() - started, kind, seq: event.seq, file: event.file, range: event.range, revision: event.revision });
  console.log(`${events.at(-1).elapsedMs}ms ${kind} ${event.file ?? ''} seq=${event.seq}`);
}

const initial = `export function shippingTotal(items) {
  const subtotal = items.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );

  return { subtotal, shipping: 500, total: subtotal + 500 };
}
`;

const updated = `export function shippingTotal(items) {
  const subtotal = items.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
  const shipping = subtotal >= 5000 || items.length === 0 ? 0 : 500;

  return {
    subtotal,
    shipping,
    total: subtotal + shipping,
  };
}
`;

const checks = `import assert from 'node:assert/strict';
import test from 'node:test';
import { shippingTotal } from './shipping-total.mjs';

test('adds shipping to a small order', () => {
  assert.deepEqual(shippingTotal([{ unitPrice: 1200, quantity: 2 }]), {
    subtotal: 2400, shipping: 500, total: 2900,
  });
});

test('keeps free shipping at the threshold', () => {
  assert.equal(shippingTotal([{ unitPrice: 2500, quantity: 2 }]).shipping, 0);
});

test('does not charge shipping for an empty order', () => {
  assert.deepEqual(shippingTotal([]), { subtotal: 0, shipping: 0, total: 0 });
});
`;

mkdirSync(folder, { recursive: true });
writeFileSync(source, initial);
publish('focus', source, '1-8');
await wait(4500);
writeFileSync(test, checks);
publish('focus', test, '5-9');
await wait(4500);
writeFileSync(source, updated);
publish('decision', source, '6-12', 'Frete grátis a partir do limite e nenhum frete para um pedido vazio.');
await wait(4500);
publish('focus', test, '11-17');
await wait(4500);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', test], { encoding: 'utf8' });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) throw new Error('Synthetic fixture tests failed');
publish('focus', source, '1-12');
writeFileSync(resolve(folder, 'events.json'), JSON.stringify(events, null, 2) + '\n');
console.log('Demo edits complete. Leave Follow running for human Pause/Resume/Stop validation.');
