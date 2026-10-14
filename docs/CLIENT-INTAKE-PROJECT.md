# ESQ AI client intake assistant

Updated: October 14, 2026 (America/Toronto).

Goal: automate prospective-client contacts and pending matters in Clio Manage,
send the existing Microsoft Forms, match submissions to the correct matter,
and prepare intake summaries and follow-up questions with SharePoint storage.

Implementation: [PR #13](https://github.com/ESQ-LS/clio-mcp/pull/13).
GitHub Issues is disabled in this repository, so this file is the project tracker.

## Delivery checklist

- [x] Inspect the connected Clio plugin and verify read access.
- [x] Implement preview-controlled contact and matter creation/update tools.
- [x] Step 1: harden and test before deployment.
  - [x] Request current ETags and send `If-Match` on contact and matter updates.
  - [x] Update existing nested email, phone, and address entries by ID; preserve
    unspecified address fields; refuse ambiguous selection unless an ID is provided.
  - [x] Bind confirmation tokens to the authenticated Clio user and API region.
  - [x] Invalidate preview tokens after a server restart or on another replica.
  - [x] Complete regression tests and sync the hardening changes to GitHub.
- [ ] Step 2: review and merge the PR, enable the four intake tools in
  `ESQ_WRITE_TOOLS` while preserving existing billing tools, and redeploy Azure.
- [ ] Step 3: refresh the plugin catalog and verify discovery and write authorization.
- [ ] Step 4: test with labelled test contacts and a pending matter; verify creation,
  updates, duplicates, expired/reused tokens, stale records, and audit entries.
- [ ] Step 5: connect form invitations and responses using a unique intake reference
  linking the Clio matter, form invitation, response, and SharePoint documents.
- [ ] Step 6: evaluate an intake review dashboard after the workflow works end to end.

## Boundaries and release notes

Source changes do not deploy the live plugin. Production write permissions and
live Clio behavior still need verification. Contact custom fields remain read-only.
Form/email automation and the dashboard are future work. Client acceptance and
conflict clearance remain lawyer decisions.

Preview tokens expire after 15 minutes and require unchanged proposals. Updates
check the current ETag before confirmation and use Clio's conditional PATCH to
protect against edits that race with the write. Tokens are specific to a Clio
user, API region, and server process; after a restart or replica change, preview again.
No live Clio records are required to complete step 1.

Step 1 validation: 17 test files / 130 tests passed; TypeScript build and
`git diff --check` passed. Tests use synthetic records and mocked API calls.
Next action: review PR #13 for merge and deployment (step 2).
