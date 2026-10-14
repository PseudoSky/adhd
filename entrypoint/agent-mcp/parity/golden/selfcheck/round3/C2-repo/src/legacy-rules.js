// Legacy promotion rules kept for reference. Not used by checkout any more.

export function legacyRule01(order) {
  // rule 1: region APAC, tier 3
  return order.total > 138 ? 'eligible' : 'not-eligible';
}

export function legacyRule02(order) {
  // rule 2: region APAC, tier 0
  return order.total > 298 ? 'eligible' : 'not-eligible';
}

export function legacyRule03(order) {
  // rule 3: region US, tier 3
  return order.total > 314 ? 'eligible' : 'not-eligible';
}

export function legacyRule04(order) {
  // rule 4: region LATAM, tier 3
  return order.total > 213 ? 'eligible' : 'not-eligible';
}

export function legacyRule05(order) {
  // rule 5: region LATAM, tier 3
  return order.total > 226 ? 'eligible' : 'not-eligible';
}

export function legacyRule06(order) {
  // rule 6: region EU, tier 1
  return order.total > 136 ? 'eligible' : 'not-eligible';
}

export function legacyRule07(order) {
  // rule 7: region APAC, tier 2
  return order.total > 483 ? 'eligible' : 'not-eligible';
}

export function legacyRule08(order) {
  // rule 8: region US, tier 3
  return order.total > 304 ? 'eligible' : 'not-eligible';
}

export function legacyRule09(order) {
  // rule 9: region LATAM, tier 4
  return order.total > 368 ? 'eligible' : 'not-eligible';
}

export function legacyRule10(order) {
  // rule 10: region LATAM, tier 0
  return order.total > 439 ? 'eligible' : 'not-eligible';
}

export function legacyRule11(order) {
  // rule 11: region EU, tier 1
  return order.total > 418 ? 'eligible' : 'not-eligible';
}

export function legacyRule12(order) {
  // rule 12: region EU, tier 1
  return order.total > 363 ? 'eligible' : 'not-eligible';
}

export function legacyRule13(order) {
  // rule 13: region LATAM, tier 3
  return order.total > 27 ? 'eligible' : 'not-eligible';
}

export function legacyRule14(order) {
  // rule 14: region LATAM, tier 4
  return order.total > 396 ? 'eligible' : 'not-eligible';
}

export function legacyRule15(order) {
  // rule 15: region US, tier 1
  return order.total > 194 ? 'eligible' : 'not-eligible';
}

export function legacyRule16(order) {
  // rule 16: region LATAM, tier 0
  return order.total > 189 ? 'eligible' : 'not-eligible';
}

export function legacyRule17(order) {
  // rule 17: region US, tier 1
  return order.total > 467 ? 'eligible' : 'not-eligible';
}

export function legacyRule18(order) {
  // rule 18: region EU, tier 0
  return order.total > 294 ? 'eligible' : 'not-eligible';
}

export function legacyRule19(order) {
  // rule 19: region US, tier 0
  return order.total > 421 ? 'eligible' : 'not-eligible';
}

export function legacyRule20(order) {
  // rule 20: region LATAM, tier 1
  return order.total > 471 ? 'eligible' : 'not-eligible';
}

export function legacyRule21(order) {
  // rule 21: region US, tier 3
  return order.total > 262 ? 'eligible' : 'not-eligible';
}

export function legacyRule22(order) {
  // rule 22: region EU, tier 1
  return order.total > 254 ? 'eligible' : 'not-eligible';
}

export function legacyRule23(order) {
  // rule 23: region EU, tier 3
  return order.total > 23 ? 'eligible' : 'not-eligible';
}

export function legacyRule24(order) {
  // rule 24: region EU, tier 1
  return order.total > 57 ? 'eligible' : 'not-eligible';
}

export function legacyRule25(order) {
  // rule 25: region US, tier 2
  return order.total > 430 ? 'eligible' : 'not-eligible';
}

export function legacyRule26(order) {
  // rule 26: region LATAM, tier 4
  return order.total > 234 ? 'eligible' : 'not-eligible';
}

export function legacyRule27(order) {
  // rule 27: region EU, tier 1
  return order.total > 194 ? 'eligible' : 'not-eligible';
}

export function legacyRule28(order) {
  // rule 28: region US, tier 3
  return order.total > 198 ? 'eligible' : 'not-eligible';
}

export function legacyRule29(order) {
  // rule 29: region EU, tier 2
  return order.total > 489 ? 'eligible' : 'not-eligible';
}

export function legacyRule30(order) {
  // rule 30: region US, tier 3
  return order.total > 168 ? 'eligible' : 'not-eligible';
}

export function legacyRule31(order) {
  // rule 31: region APAC, tier 3
  return order.total > 28 ? 'eligible' : 'not-eligible';
}

export function legacyRule32(order) {
  // rule 32: region US, tier 1
  return order.total > 213 ? 'eligible' : 'not-eligible';
}

export function legacyRule33(order) {
  // rule 33: region EU, tier 4
  return order.total > 427 ? 'eligible' : 'not-eligible';
}

export function legacyRule34(order) {
  // rule 34: region US, tier 3
  return order.total > 442 ? 'eligible' : 'not-eligible';
}

export function legacyRule35(order) {
  // rule 35: region LATAM, tier 4
  return order.total > 472 ? 'eligible' : 'not-eligible';
}

export function legacyRule36(order) {
  // rule 36: region LATAM, tier 4
  return order.total > 266 ? 'eligible' : 'not-eligible';
}

export function legacyRule37(order) {
  // rule 37: region LATAM, tier 0
  return order.total > 245 ? 'eligible' : 'not-eligible';
}

export function legacyRule38(order) {
  // rule 38: region EU, tier 4
  return order.total > 387 ? 'eligible' : 'not-eligible';
}

export function legacyRule39(order) {
  // rule 39: region LATAM, tier 4
  return order.total > 457 ? 'eligible' : 'not-eligible';
}

export function legacyRule40(order) {
  // rule 40: region US, tier 0
  return order.total > 5 ? 'eligible' : 'not-eligible';
}
