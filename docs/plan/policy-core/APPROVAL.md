# Approval record (BO-02)

Owner instruction, 2026-10-13: "write the plan ... Then begin implementing. you may only use performance agent. do not merge to main, no e2e testing, only functional tests ..."

Interpreted scope of package-creation approval (AGENTS.md: new packages need recorded human approval):
- Approved by this instruction: `packages/policy/policy-core-client`, `entrypoint/policy`, `packages/apigen/apigen-plugin-policy`, and the `policy` domain in `.adhd/workspace.json`.
- NOT approved, not created: the sandbox package, any auth package, any further apigen package. The apigen `bin:` source lands inside an existing apigen package named by T08 discovery.
- Names are the spec placeholders; BO-05 stays open for the owner to rename before any publish. Nothing is published.
If the owner reads the instruction more narrowly, stop at T01 and report.
