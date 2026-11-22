import assert from 'node:assert/strict';
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
