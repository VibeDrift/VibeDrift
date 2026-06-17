import {
  formatMoney,
  slugify,
  formatStampDate,
  truncateText,
  parseDuration,
} from "./lib/format";

export function renderInvoiceLine(item) {
  return {
    slug: slugify(item.name),
    price: formatMoney(item.cents, item.currency),
    when: formatStampDate(item.ts),
    blurb: truncateText(item.description, 40),
    ttlMs: parseDuration(item.ttl),
  };
}
