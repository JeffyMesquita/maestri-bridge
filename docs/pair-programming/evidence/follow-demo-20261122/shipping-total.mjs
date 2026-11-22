export function shippingTotal(items) {
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
