import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invoiceTotal } from './invoice.mjs';

test('adds the invoice line items', () => {
  assert.equal(invoiceTotal([{ price: 12, quantity: 2 }, { price: 9, quantity: 1 }]), 33);
});
