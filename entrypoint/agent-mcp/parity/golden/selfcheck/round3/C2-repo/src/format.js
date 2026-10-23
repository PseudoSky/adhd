export function roundCents(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function money(x) {
  return `$${roundCents(x).toFixed(2)}`;
}
