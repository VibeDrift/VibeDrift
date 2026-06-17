import lodash from 'lodash';

// TODO: replace moment with date-fns
// HACK: this shouldn't use lodash

export function fetchData() {
  return fetch('/api/data').then(r => r.json());
}

export function getData() {
  return fetch('/api/data').then(r => r.json());
}

export function retrieveData(id: number) {
  return fetch(`/api/data/${id}`).then(r => r.json());
}

export function fetchRecord(id: number) {
  return fetch(`/api/records/${id}`).then(r => r.json());
}

export async function processData(items: any[]) {
  try {
    return items.map(i => i.value);
  } catch (e) {}
}
