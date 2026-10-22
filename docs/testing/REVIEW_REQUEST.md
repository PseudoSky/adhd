# REVIEW_REQUEST — independent review of the testing standard documents

This file is for whoever dispatches the review. **Do not give this file to the reviewer.** The reviewer receives only the prompt in the code block of Pass 1 or Pass 2 below, exactly as written (blind review: the content and the task "Review", nothing else).

## Dispatch rules

- Run each pass in the background, anonymous, with `model` and `tools` stated.
- Tools: Read and Write. Add WebFetch to Pass 1 only if the cited source URLs should be checked. No memory, search, or agent tools.
- Give the reviewer no conversation, rationale, decision list, or other file paths. If it asks for context, answer with the same prompt.
- The author of the documents does not approve them and does not act on the review alone. Findings go to a separate agent or to the owner.
- The roster has no `review` agent yet (finding F1, backlog item `3fe895f3`). The closest installed fits are `doc-reviewer` (reviews documents) and `architect` (attacks mechanisms); check the chosen agent's spec before dispatching. Use a reviewer that did not take part in the first round or in the fixes.

## Pass 1 — the portable policy

Output: `/Users/nix/dev/node/adhd/docs/testing/REVIEW-4.md` (earlier rounds are kept as the record; use a new number each round)

```
Review

Content to review: /Users/nix/dev/node/adhd/docs/testing/STRATEGY.md

Write your findings to /Users/nix/dev/node/adhd/docs/testing/REVIEW-4.md
(overwrite it if it exists). Do not edit any other file.
```

## Pass 2 — the operating model, mappings, and task list

Run after Pass 1 (or in parallel; it writes a separate file). The map cannot be reviewed without the policy it maps.

Output: `/Users/nix/dev/node/adhd/docs/testing/REVIEW-MAP-4.md` (the first round's `REVIEW-MAP.md` is kept as the record)

```
Review

Content to review:
/Users/nix/dev/node/adhd/docs/testing/STRATEGY.md
/Users/nix/dev/node/adhd/docs/testing/STRATEGY_MAP.md
/Users/nix/dev/node/adhd/docs/testing/STATE.md

Write your findings to /Users/nix/dev/node/adhd/docs/testing/REVIEW-MAP-4.md
(overwrite it if it exists). Do not edit any other file.
```

## After the review

1. Rounds 1 to 3 are done (`REVIEW.md`, `REVIEW-MAP.md`, `REVIEW-3.md`, `REVIEW-MAP-3.md`; dispositions in `REVIEW_TRIAGE.md`). The prompts above write `REVIEW-4.md` and `REVIEW-MAP-4.md`; change the number again for each later round, because a reused name is overwritten. Read the results without editing the documents.
2. Hand the findings to a party other than the author for triage, or to the owner.
3. Accepted findings become edits to the documents (author fixes) or backlog items, and the review files stay as the record. The first round's dispositions are in `REVIEW_TRIAGE.md`; the second round's are appended to it as a new section.

## Where the prompts deliberately say nothing

They do not tell the reviewer what to check (enforceability, contradictions, citations, mechanism failure modes, checkable acceptance criteria). Naming review points would turn a clean read into a convergent one.
