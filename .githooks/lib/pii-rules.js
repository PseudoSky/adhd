'use strict';

/**
 * pii-rules.js — high-signal PII + structured-data-dump detection.
 *
 * WHY THIS EXISTS
 * `check-no-credentials.js` was credential-only, and it skipped any file
 * > 4 MiB (`sanitize`) and any line > 4096 chars (the per-line loop). So a
 * real 9.8 MB dating-app export — 570 person records (name / birth_date /
 * gender / bio), 20,573 CDN photo URLs and private message threads —
 * committed as a JSON test fixture was never scanned at all.
 *
 * DESIGN PRINCIPLES
 *  1. Prefer SHAPE over field regexes. The decisive signal for a third-party
 *     data dump is that a file IS a large, repetitive array of person records
 *     — not that any one field matches a pattern. Bare email/phone/DOB
 *     regexes are false-positive factories in a code repo (package.json
 *     author emails, docs, test vectors) and a noisy gate gets bypassed.
 *  2. Only checksum-/format-VALIDATED identifiers are gated directly
 *     (SSN, Luhn credit-card, mod-97 IBAN). Everything else is DENSITY-gated
 *     (>= N distinct values in one file == a dump, not an incidental mention).
 *  3. Every rule is allowlistable: per line via `pragma: allowlist pii`
 *     (or the existing `pragma: allowlist secret`), or per file via a
 *     file-level `pragma: allowlist pii` in its first 4 KiB.
 *
 * Zero dependencies, deterministic, offline — the same contract as the
 * credential scanner it plugs into.
 */

/**
 * Hosts that essentially never appear in honest source, but DO appear in a
 * third-party data export (photo CDNs, vendor APIs). Extend as incidents
 * occur. Matched as a plain substring against file content.
 */
const VENDOR_PII_DOMAINS = [
  'images-ssl.gotinder.com',
  'api.gotinder.com',
];

/**
 * Field names that are rare in ordinary source code but dense in a person
 * record dump. Gating on >= 2 of these each appearing >= 10 times, or >= 50
 * total, distinguishes a 570-record export from a schema that mentions
 * `gender` once.
 */
const STRONG_PERSON_KEYS = [
  'birth_date', 'birthdate', 'birthday', 'date_of_birth', 'dob',
  'gender', 'sexual_orientation', 'orientation',
  'ssn', 'social_security_number', 'national_id', 'passport_number',
  'home_address', 'street_address', 'postal_code', 'zip_code',
];

/** Distinct values in one file above which the file is a dump, not a mention. */
const EMAIL_DUMP_MIN = 25;
const PHONE_DUMP_MIN = 25;
/** A newly-added file larger than this is flagged (canonical size gate). */
const LARGE_ADDED_BYTES = 1024 * 1024; // 1 MiB
/** A single-line file larger than this is almost certainly a dumped bundle. */
const MINIFIED_BYTES = 1024 * 1024; // 1 MiB

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// E.164 only — bare national formats are too false-positive-prone to gate.
const E164_RE = /\+\d{7,15}\b/g;
const US_SSN_RE = /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;
const CC_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN_CANDIDATE_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
// A Luhn-valid digit run alone is NOT a card: UUID fragments like
// `00000000-0000-0000-` and `11111111-1111-4111-` are Luhn-valid (sum 0, or
// coincidentally) and riddled through schema snapshots, fixtures and test
// vectors. So a card is only reported when (a) the digits are not all the
// same, and (b) a card-context word sits within a window of the match.
// No trailing \b on purpose: `card_number` / `cardNumber` / `card-number` all
// count as context, and `_` is a word char that would defeat a trailing \b.
const CARD_CONTEXT_RE = /\b(?:card|credit|debit|pan|visa|mastercard|amex|american ?express|discover|diners|jcb|payment)/i;
const CARD_CONTEXT_WINDOW = 64;
const ALL_SAME_DIGIT_RE = /^(\d)\1+$/;

/** Count non-overlapping matches of a global regex. */
function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

/** Luhn checksum over the digits of a candidate. */
function luhnValid(s) {
  const d = s.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (dbl) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** IBAN mod-97 == 1 check. */
function ibanValid(candidate) {
  const s = candidate.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  // mod 97 on a potentially long numeric string, computed in chunks.
  let rem = 0;
  for (const ch of expanded) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return rem === 1;
}

/**
 * True only for a Luhn-valid, non-degenerate digit run that sits within a
 * card-context window — the FP filter that keeps UUID fragments out.
 */
function findCard(content) {
  const re = new RegExp(CC_CANDIDATE_RE.source, 'g');
  let m;
  while ((m = re.exec(content)) !== null) {
    const digits = m[0].replace(/\D/g, '');
    if (ALL_SAME_DIGIT_RE.test(digits)) continue; // 0000000000000000
    if (!luhnValid(digits)) continue;
    const start = Math.max(0, m.index - CARD_CONTEXT_WINDOW);
    const end = Math.min(content.length, m.index + m[0].length + CARD_CONTEXT_WINDOW);
    if (CARD_CONTEXT_RE.test(content.slice(start, end))) return true;
  }
  return false;
}

/** Count occurrences of each JSON/JSONL object key (`"key":`). */
function countJsonKeys(text) {
  const counts = Object.create(null);
  const re = /["']([A-Za-z0-9_]+)["']\s*:/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const k = m[1].toLowerCase();
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

/**
 * Shape check that needs no file content — only the index metadata.
 * @param {{path: string, size: number, status: string}} entry
 *   `status` is a git name-status code (`A` added, `M` modified, `C` copied,
 *   `R` renamed). Only newly-ADDED large files are flagged; a modified
 *   pre-existing file is not "new data entering the repo".
 * @returns {Array<{rule: string, why: string}>}
 */
function scanShape(entry) {
  const findings = [];
  if (entry.status === 'A' && entry.size > LARGE_ADDED_BYTES) {
    findings.push({
      rule: 'pii:large-added-file',
      why: `newly-added file is ${(entry.size / 1048576).toFixed(1)} MiB ` +
        `(> ${LARGE_ADDED_BYTES / 1048576} MiB) — move large fixtures to a ` +
        `synthetic sample or allowlist deliberately`,
    });
  }
  return findings;
}

/**
 * Content scan — whole-file, shape-first. Never skips a file for being large
 * (the previous 4 MiB cap was the whole reason the leak got through).
 * @param {string} content
 * @returns {Array<{rule: string, why: string}>}
 */
function scanContent(content) {
  const findings = [];

  // 1. vendor data domains — near-zero false positive, near-infinite signal.
  for (const d of VENDOR_PII_DOMAINS) {
    if (content.includes(d)) {
      findings.push({
        rule: 'pii:vendor-data-domain',
        why: `contains third-party data host "${d}" — this is an export, not source`,
      });
      break;
    }
  }

  // 2. structured person-record dump (the shape that actually leaked).
  const counts = countJsonKeys(content);
  const strongKeys = STRONG_PERSON_KEYS.filter((k) => (counts[k] || 0) >= 10);
  const strongTotal = STRONG_PERSON_KEYS.reduce((n, k) => n + (counts[k] || 0), 0);
  if (strongKeys.length >= 2 || strongTotal >= 50) {
    findings.push({
      rule: 'pii:structured-person-dump',
      why: `looks like a person-record dataset ` +
        `(${strongKeys.length} sensitive field(s) repeated >= 10x` +
        (strongKeys.length ? `: ${strongKeys.join(', ')}` : '') + `)`,
    });
  }

  // 3. density — a file with many distinct emails/phones is an export.
  const emails = new Set((content.match(EMAIL_RE) || []).map((s) => s.toLowerCase()));
  if (emails.size >= EMAIL_DUMP_MIN) {
    findings.push({
      rule: 'pii:email-dump',
      why: `${emails.size} distinct email addresses in one file (>= ${EMAIL_DUMP_MIN})`,
    });
  }
  const phones = new Set(content.match(E164_RE) || []);
  if (phones.size >= PHONE_DUMP_MIN) {
    findings.push({
      rule: 'pii:phone-dump',
      why: `${phones.size} distinct E.164 phone numbers in one file (>= ${PHONE_DUMP_MIN})`,
    });
  }

  // 4. checksum/format-validated identifiers — a single real one is enough.
  if (countMatches(content, US_SSN_RE) > 0) {
    findings.push({ rule: 'pii:us-ssn', why: 'a valid-shaped US Social Security number' });
  }
  if (findCard(content)) {
    findings.push({ rule: 'pii:credit-card', why: 'a Luhn-valid payment card number in card context' });
  }
  for (const c of content.match(IBAN_CANDIDATE_RE) || []) {
    if (ibanValid(c)) {
      findings.push({ rule: 'pii:iban', why: 'a mod-97-valid IBAN' });
      break;
    }
  }

  // 5. a multi-MB single-line file is a dumped blob, whatever its content.
  if (Buffer.byteLength(content) > MINIFIED_BYTES && !content.slice(0, 4096).includes('\n')) {
    findings.push({
      rule: 'pii:minified-large-file',
      why: `> ${MINIFIED_BYTES / 1048576} MiB with no newline in the first 4 KiB`,
    });
  }

  return findings;
}

module.exports = {
  VENDOR_PII_DOMAINS,
  STRONG_PERSON_KEYS,
  LARGE_ADDED_BYTES,
  EMAIL_DUMP_MIN,
  PHONE_DUMP_MIN,
  scanShape,
  scanContent,
  // exported for tests
  luhnValid,
  ibanValid,
  countJsonKeys,
};
