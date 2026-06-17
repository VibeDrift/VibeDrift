// Utility: currency formatting
export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
