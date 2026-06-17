// Shared formatting / parsing helpers used across the reporting layer.
// These live in lib/ and are imported wherever this logic is needed —
// they are not re-implemented per module.

export function formatMoney(cents, currency) {
  const amount = (cents / 100).toFixed(2);
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency + " ";
  const [whole, frac] = amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${symbol}${grouped}.${frac}`;
}

export function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function formatStampDate(ts) {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function truncateText(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

export function parseDuration(str) {
  const match = /^(\d+)(s|m|h|d)$/.exec(str.trim());
  if (!match) throw new Error("bad duration: " + str);
  const n = Number(match[1]);
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  return n * mult;
}
