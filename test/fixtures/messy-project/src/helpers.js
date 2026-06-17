import { formatDate } from './utils';

export function format_date(date) {
  return date.toISOString();
}

export function formatTimestamp(ts) {
  return new Date(ts).toISOString();
}

export async function save_record(record) {
  const res = await fetch('/api/save', {
    method: 'POST',
    body: JSON.stringify(record),
  });
  return res.json();
}

export async function saveItem(item) {
  const res = await fetch('/api/save', {
    method: 'POST',
    body: JSON.stringify(item),
  });
  return res.json();
}
