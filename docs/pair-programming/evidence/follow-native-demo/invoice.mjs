export function invoiceTotal(items) {
  const subtotal = items.reduce((sum, { price, quantity }) => sum + price * quantity, 0);
  return subtotal;
}
