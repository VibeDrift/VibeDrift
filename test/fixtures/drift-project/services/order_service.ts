// ← DRIFT: Has inline currency formatting that duplicates utils/format.ts

export function calculateOrderTotal(items: { price: number; quantity: number }[]): string {
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  // Inline currency formatting — should use formatCurrency() from utils/format.ts
  const display = '$' + total.toFixed(2);
  return display;
}

export function calculateTax(subtotal: number, rate: number): string {
  const tax = subtotal * rate;
  // Again, inline formatting
  return '$' + tax.toFixed(2);
}

export function formatOrderDate(date: Date): string {
  // Duplicates formatDate from utils/format.ts
  return date.toISOString().split('T')[0];
}
