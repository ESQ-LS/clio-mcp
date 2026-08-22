# ESQ Clio MCP controlled time-entry writes

**Status:** Deployed - Clio reauthorization required

## 1. Objective

Extend the existing production ESQ Clio MCP with controlled `create_time_entry` and `update_time_entry` tools while keeping deletion unavailable and production mutations confirmation-gated.

## 2. Existing environment

- Source repository: `https://github.com/ESQ-LS/clio-mcp.git`
- Working branch: `codex/controlled-time-entry-writes`
- Production baseline: `origin/esq/main` at `4945fc4`
- Azure subscription: `Azure subscription 1` (`acc8e362-27d4-45ae-9761-9b274e80e649`)
- Azure region: Canada Central
- Resource group: `rg-esq-pathb-mcp`
- Container App: `ca-esq-clio-mcp`
- Endpoint: `https://ca-esq-clio-mcp.mangostone-06ffdb69.canadacentral.azurecontainerapps.io`
- Container registry: `esqdocxmcpacr.azurecr.io` in `rg-esq-docx-mcp`
- Current image: `esqdocxmcpacr.azurecr.io/esq-clio-mcp:esq-4945fc420cbd`
- Deployment recipe: existing GitHub Actions / Azure CLI container-image rollout

The user's instruction to use the existing source repository and existing Azure Container App is treated as approval to retain this discovered subscription and region. No new Azure resources are planned.

## 3. Implementation scope

- Add dry-run-first `create_time_entry` and `update_time_entry` operations.
- Require `confirm_write: true` for every production mutation.
- Return a complete preview containing matter, date, lawyer, duration, rate, billing status and narrative before any write.
- Require an explicit supporting-evidence description for creation.
- Validate matter, user, activity description, date, duration, rate, status, activity ID and ETag as applicable.
- Reject updates to billed, on-bill, written-off, deleted or non-TimeEntry activities.
- Use the current Clio activity ETag for optimistic concurrency on updates.
- Keep every deletion operation unavailable.
- Add confidentiality-safe audit events that exclude narratives, evidence details, tokens and raw API responses.
- Add synthetic unit and integration coverage.

## 4. Safety constraints

- No client time entry will be created or modified during implementation or smoke testing.
- No authentication, permission, invoice, payment, billing or deletion mutations.
- Existing broad write tools remain withheld; only the two controlled tools may be exposed.
- No confidential narratives, tokens or raw API responses in logs or fixtures.
- Existing secret references and production OAuth configuration remain unchanged.
- Failed audit persistence blocks confirmed mutations so writes are not performed without an audit trail.

## 5. Validation and deployment

- Repository-specific unit tests, build and tool-manifest verification.
- Legal-tech data-handling review.
- Clio integration review.
- Independent diff verification.
- Azure readiness validation with recorded proof.
- Build and push an immutable image tag using the existing registry.
- Update only the existing Container App image and controlled write-tool allowlist.
- Verify the published MCP schemas and perform authentication plus dry-run production smoke tests only.
- Retain the previous Container App revision/image for rollback.

## 6. Work items

- [x] Discover repository and current deployment configuration
- [x] Confirm production target from the user's existing-app instruction
- [x] Inspect current Clio client, MCP schemas and audit subsystem
- [x] Implement controlled creation and editing
- [x] Add synthetic tests
- [x] Complete security and integration reviews
- [x] Validate deployment readiness
- [x] Deploy to existing Container App
- [x] Verify schemas and non-mutating production health

## 7. Validation Proof

- Validation completed: `2026-08-20T21:08:58Z`
- `npm ci`: passed; 185 packages audited, zero vulnerabilities.
- `npm test`: passed; 13 test files and 118 synthetic tests.
- `npm run test:coverage`: passed; controlled time-entry module 90.62% line coverage.
- `npm run build`: passed TypeScript production build.
- `git diff --check`: passed.
- MCP stdio manifest: read-only default advertises 21 tools and withholds all writes.
- MCP stdio manifest with controlled allowlist: advertises 23 tools, adding only `create_time_entry` and `update_time_entry`; no deletion tool.
- In-memory MCP integration test verified required confirmation/ETag schemas and mutation annotations.
- `npm audit --audit-level=high`: zero vulnerabilities.
- Secret scan of the patch: passed; no known Clio client credential values present.
- GitHub Actions deployment YAML parse: passed.
- Azure account and target discovery: exactly one `ca-esq-clio-mcp` app and one application container in the approved subscription/region.
- Existing ACR: provisioned, admin user disabled.
- Remote ACR validation build `cxc` with `--no-push`: succeeded at `2026-08-20T21:08:03Z`.
- Local Docker build: not run because Docker Desktop was unavailable; superseded by successful ACR validation build.
- Azure policy review: existing Microsoft Defender for Cloud default assignment only; no blocking deployment policy identified.
- Infrastructure template/Bicep/what-if checks: not applicable because this is an image-and-environment-variable update to existing resources; no infrastructure changes.

### Role Assignment Verification

- Status: Verified.
- Runtime identity: `id-esq-pathb-mcp` (`7c749c89-60b7-407c-9cf2-335b75172c4a`).
- Confirmed role: `AcrPull` scoped to `esqdocxmcpacr` only.
- No new identities, role assignments, scopes or infrastructure permissions are introduced.
- Clio access continues through the existing encrypted OAuth token and existing Activities scope.

## 8. Deployment Result

- Final image: `esqdocxmcpacr.azurecr.io/esq-clio-mcp:esq-controlled-time-b4e4f0b8fe5f`
- Image digest: `sha256:ff3664b05c7fa3a8d28e0041d61e33232aeccb1c4ed5bf0283030611f2f1ded3`
- Final revision: `ca-esq-clio-mcp--ctb4e4f0b8fe5f`
- Production traffic: 100% to the final revision.
- Health endpoint: passed.
- Published MCP manifest: 23 tools; adds only `create_time_entry` and `update_time_entry`; no deletion or broad legacy write tools.
- Production synthetic dry-run: invoked with `confirm_write: false` and a deliberately invalid synthetic matter ID; no write was attempted.
- Authentication status after revision replacement: unauthenticated. The existing deployment stores encrypted OAuth tokens on revision-local storage, so a new revision requires Ron to reauthorize. Authentication/storage architecture was not changed because it was outside the approved scope.
- Repository publication: authorized on `2026-08-22`; the source branch and pull-request details are reported in the implementation handoff.

## 9. Rollback

Restore the prior immutable image `esqdocxmcpacr.azurecr.io/esq-clio-mcp:esq-4945fc420cbd` and remove `create_time_entry,update_time_entry` from `ESQ_WRITE_TOOLS`. Do not delete Azure resources.
