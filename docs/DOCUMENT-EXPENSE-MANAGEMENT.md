# ESQ Clio MCP document upload and expense management

**Status:** Implemented and locally validated; not committed, pushed, merged,
enabled, or deployed.

**Evidence date:** 2026-10-30

## Objective and boundary

This change adds controlled Clio `ExpenseEntry` reads and writes and hardens the
existing matter-document upload. It does not convert a supplier invoice into a
billing decision. A lawyer must determine the correct matter, category,
recoverability, tax treatment, and allocation before invoking a write tool.

Implementation and tests use synthetic records only. No client document,
supplier invoice, token, production expense, or production document is read or
written by the test suite.

## Tool schemas

### `upload_document`

Required:

- `file_path`: absolute path beneath `ESQ_CLIO_UPLOAD_ROOT`
- `matter_id`: exact Clio matter ID

Optional:

- `folder_id`: target folder, validated as accessible and belonging to `matter_id`
- `name`: target Clio filename; the source extension is preserved when omitted
- `content_type`: MIME type, otherwise inferred from the filename
- `confirm_write`: defaults to `false`
- `preview_token`: required only with `confirm_write: true`

The dry run snapshots and hashes the source, validates the matter, and screens
for an existing same-name/same-size document. Confirmation must repeat the
unchanged proposal. The handler repeats duplicate screening, uploads immutable
snapshot parts with bounded per-part timeouts and transient retries, retries
`UploadTimeoutError` during finalization, and reads the created record back to
verify matter, requested parent, name, size, UUID, and `fully_uploaded: true`.

### `list_expense_entries`

Optional filters: `matter_id`, `expense_category_id`, `start_date`, `end_date`,
`status`, `limit`, and `page_token`. `status` defaults to `unbilled`; `limit`
defaults to 25 and is capped at 200. Results include ETags and cursor metadata.

### `get_expense_entry`

Requires `activity_id`. A non-`ExpenseEntry` activity is rejected.

### `create_expense_entry`

Required business fields:

- `matter_id` and `allocation_matter_id` (they must be identical)
- `date` in `YYYY-MM-DD`
- positive `amount`
- validated `expense_category_id`
- `description`
- single-line `source_reference`
- `billing_status`: `billable`, `non_billable`, or `no_charge`
- `tax_setting`: `no_tax`
- optional `tax_settings`: one or two explicit entries, each containing a
  `tax_rate_configuration_id`, unique `order` (`1` or `2`), and `rule`
  (`Pre`, `Post`, or `Compound`)
- `cost_type`: `client_recoverable_direct_cost`,
  `third_party_fee_recovery`, or `internal_non_billable_cost`

Control fields: `confirm_write` defaults to `false`; a confirmed call requires
the single-use, unexpired `preview_token` from the exact dry-run proposal.

The Clio payload is an `ExpenseEntry` with quantity 1. The source reference is
appended to the Clio note because Clio's `reference` field is documented for
`HardCostEntry`, not `ExpenseEntry`. Duplicate screening compares the matter,
date, amount, category, and normalized source reference before preview and
immediately before creation; a changed description does not bypass the guard.

### `update_expense_entry`

Required control fields: `activity_id`, current `etag`,
`allocation_matter_id`, `cost_type`, `confirm_write`, and (for confirmation) the
unchanged `preview_token`. At least one editable field is required: `date`,
`amount`, `expense_category_id`, `description`, `source_reference`,
`billing_status`, `tax_setting`, or `tax_settings`. Use `tax_setting: no_tax`
to clear taxes, or supply `tax_settings` to apply explicit tax-rate
configurations whose identity and rate are bound into the signed preview.

The tool rejects non-expense, billed, on-bill, stale-ETag, and cross-matter
updates. `If-Match` supplies optimistic concurrency to Clio.

## Synthetic example calls

Dry-run a document upload:

```json
{
  "file_path": "/approved/clio-staging/synthetic-invoice.pdf",
  "matter_id": 101,
  "name": "Synthetic supplier invoice.pdf",
  "confirm_write": false
}
```

Dry-run an expense creation:

```json
{
  "matter_id": 101,
  "allocation_matter_id": 101,
  "date": "2026-10-01",
  "amount": 125,
  "expense_category_id": 77,
  "description": "Synthetic registry fee.",
  "source_reference": "SYN-INV-001",
  "billing_status": "billable",
  "tax_setting": "no_tax",
  "cost_type": "client_recoverable_direct_cost",
  "confirm_write": false
}
```

After reviewing every preview field, confirmation repeats every business field
unchanged and adds:

```json
{
  "confirm_write": true,
  "preview_token": "<token returned by the immediately preceding dry run>"
}
```

## Permissions and configuration

- Clio OAuth must grant the existing Activities access needed to read/create/
  update Activities and Expense Categories, Documents access for document
  listing/upload, and Matters read access for target validation.
- The authenticated Clio user must independently have permission to view and
  change the target matter's activities/documents.
- HTTP transport requires `MCP_API_KEY`; write-tool registration fails closed
  without it.
- `ESQ_CLIO_UPLOAD_ROOT` must be an absolute, dedicated staging directory.
- Write tools remain absent unless their exact names are in `ESQ_WRITE_TOOLS`.
  For this feature those names are `upload_document`,
  `create_expense_entry`, and `update_expense_entry`.
- Do not enable the legacy broad `create_activity` or `log_time_entry` tools.

## Limitations

- This implementation supports `ExpenseEntry` only, not `HardCostEntry` or
  `SoftCostEntry`.
- Billable expenses on matters requiring mandatory UTBMS expense codes are
  refused because this schema does not accept `utbms_expense`.
- The legacy `tax_setting` field is accepted only as `no_tax`. Taxed expenses
  use the explicit `tax_settings` array so the selected Clio rate
  configurations are validated and bound into the signed preview.
- Duplicate screening is defensive, not a database uniqueness constraint. An
  ambiguous network failure must be reconciled by reading Clio before retrying.
- The upload duplicate key is exact filename plus byte size in the matter; Clio
  does not expose the local SHA-256 for server-side comparison.
- Document upload supports either the matter root or an explicitly validated
  folder within the same matter. Document categories are not part of this change.
- Preview tokens are actor-, region-, process-, proposal-, and time-bound and
  intentionally stop working after a restart or replica change.

## Deployment instructions (not executed)

1. Complete code/security review against the exact branch head and resolve all
   current-head findings.
2. Run `npm ci`, `npm test`, `npm run build`, `npm audit --audit-level=high`,
   `git diff --check`, and the repository's MCP manifest verification.
3. Confirm the Clio developer application and authenticated user's Activities,
   Expense Categories, Documents, and Matters permissions without changing
   them.
4. Record the current immutable image, Container App revision, traffic, health,
   `ESQ_WRITE_TOOLS`, and rollback command.
5. Build an immutable image from the reviewed commit. Do not reuse a mutable
   tag.
6. With separate deployment authorization, update only the existing image and
   append the three exact write-tool names to the approved allowlist. Preserve
   `MCP_API_KEY`, OAuth secrets, region, timezone, and upload-root settings.
7. Verify health and the published tool schemas before any client-matter call.
8. Roll back to the recorded image and allowlist if health, authentication,
   schema discovery, audit persistence, or a dry-run check fails.

## Post-deployment acceptance sequence

This sequence deliberately stops before a production billing mutation unless a
separate, explicit approval is given.

1. Verify `/health` without credentials and verify that every MCP/OAuth route
   retains its intended authentication boundary.
2. Authenticate as the intended Clio user and read back the user/region.
3. Discover tools and confirm only the approved write allowlist is visible;
   confirm `create_activity`, `log_time_entry`, and all delete tools are absent.
4. Read the supplied matter, expense category, current expense list, and target
   document list. Confirm the matter is open and the category is correct.
5. Stage the supplied invoice under the approved upload root and call
   `upload_document` with `confirm_write: false`. Verify filename, size, hash,
   matter, and duplicate-screen result. Stop if any field differs.
6. Call `create_expense_entry` with `confirm_write: false` using only the
   lawyer-approved allocation. Verify matter, amount, category, description,
   source reference, billing status, tax, and cost classification. Stop if the
   invoice includes costs attributable to another matter or internal expenses
   not recoverable from this client.
7. Record the dry-run evidence and obtain separate authorization for each live
   write. Without that authorization, do not confirm either preview.
8. If later authorized, confirm the document upload first and read it back from
   Clio. Then obtain a fresh expense preview, confirm it once, and read back the
   `ExpenseEntry` and ETag. Reconcile an ambiguous response before any retry.
9. Confirm audit entries contain IDs and control metadata only, not document
   content, descriptions, supplier references, amounts, or tokens.

## Project continuity

- Completed: replay onto base `0fd164f`; controlled expense read/create/update
  implementation; root-or-folder document upload; duplicate, structured-timeout,
  redacted-record, category-compatibility, and association hardening; synthetic
  regression tests; schemas and rollout documentation. A fresh local correctness
  and security review found no unresolved blocker.
- Local validation: 23 Vitest files and 233 tests passed; the production
  TypeScript build, clean-install, coverage, dependency audit, package dry-run,
  whitespace, and MCP schema/allowlist checks passed. The dependency audit
  reports zero vulnerabilities. The controlled allowlist exposes exactly the
  intended document/expense writes and refuses the legacy broad activity
  handlers.
- Pending: commit/push authorization, commit, push, pull-request review, merge,
  deployment, and live acceptance.
- Blocked: no technical blocker; every publication and production step remains
  an independent approval gate.
- Next gate: decide whether to authorize commit and push of this exact local diff.
