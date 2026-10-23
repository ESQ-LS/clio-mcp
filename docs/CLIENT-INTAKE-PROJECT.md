# ESQ AI client intake assistant

Updated: October 23, 2026 (America/Toronto).

Goal: support a solo-lawyer Clio workflow with efficient, preview-controlled
routine writes while reserving destructive, financial, trust, permission, and
bulk operations for Clio's native interface.

Initial implementation: [PR #13](https://github.com/ESQ-LS/clio-mcp/pull/13).
The expanded solo-practice implementation is in superseding
[PR #14](https://github.com/ESQ-LS/clio-mcp/pull/14) on
`codex/solo-write-capabilities`.
GitHub Issues is disabled in this repository, so this file is the project tracker.

## Delivery checklist

- [x] Inspect the connected Clio plugin and verify read access.
- [x] Implement preview-controlled contact and matter creation/update tools.
- [x] Expand ordinary contact and matter fields, including custom fields,
  assignments, lifecycle dates, stages, groups, location, and limitation dates.
- [x] Add preview controls to tasks, task completion, notes, communications,
  calendar entries, and exact-file document uploads.
- [x] Align document upload with the actual upstream path: Clio to the
  Clio-managed OneDrive `/Clio` tree, then to SharePoint `Clio Mirror`.
- [x] Step 1: harden and test before deployment.
  - [x] Request current ETags and send `If-Match` on contact and matter updates.
  - [x] Update existing nested email, phone, and address entries by ID; preserve
    unspecified address fields; refuse ambiguous selection unless an ID is provided.
  - [x] Bind confirmation tokens to the authenticated Clio user and API region.
  - [x] Invalidate preview tokens after a server restart or on another replica.
  - [x] Complete regression tests and sync the hardening changes to GitHub.
- [x] Step 2: complete focused and full regression coverage and review the
  expanded branch.
- [x] Step 3: commit, push, and open the superseding pull request.
- [ ] Step 4: complete review, merge only after approval, select exact tools in
  `ESQ_WRITE_TOOLS`, and redeploy only with separate authorization.
- [ ] Step 5: refresh the plugin catalog and verify discovery and write authorization.
- [ ] Step 6: test with labelled test contacts and a pending matter; verify creation,
  updates, duplicates, expired/reused tokens, stale records, and audit entries.
- [ ] Step 7: connect form invitations and responses using a unique intake reference
  linking the Clio matter, form invitation, response, and SharePoint documents.
- [ ] Step 8: evaluate an intake review dashboard after the workflow works end to end.

## Boundaries and release notes

Source changes do not deploy the live plugin. Production write permissions and
live Clio behavior still need verification. Ordinary contact and matter custom
field values are writable through the controlled create/update tools. Delete and
nested `_destroy` operations remain unavailable.
Form/email automation and the dashboard are future work. Client acceptance and
conflict clearance remain lawyer decisions.

Preview tokens expire after 15 minutes and require unchanged proposals. Updates
check the current ETag before confirmation and use Clio's conditional PATCH to
protect against edits that race with the write. Tokens are specific to a Clio
user, API region, and server process; after a restart or replica change, preview again.
No live Clio records are required to complete step 1.

Expanded-branch validation: 19 test files / 135 tests passed; the production
TypeScript build, full dependency audit (zero vulnerabilities), and
`git diff --check` passed. Tests use synthetic records and mocked API calls.
Next action: complete review of PR #14; do not merge or deploy without separate
authorization.
