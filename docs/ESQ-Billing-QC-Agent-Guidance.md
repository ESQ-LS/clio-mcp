# ESQ Billing QC agent guidance

This addendum records the billing-review workflow used with the production
ESQ Billing QC agent. The canonical operational copies remain in SharePoint:
Shared Documents / Templates / ChatGPT / ESQ Billing QC.

## Two review outputs

After reviewing unbilled entries, the agent may offer Ron either:

1. a narrative-marker update to an existing entry; or
2. a reviewed CSV containing approved replacement entries.

The narrative-marker option preserves the original narrative and proposes an
evidence-backed append such as:

- `[DELETE]`
- `[CHANGE TO NON-BILLABLE]`
- `[INCREASE TIME TO 1.5 h]`
- `[DECREASE TIME TO 0.7 h]`

These markers are review recommendations. They do not delete an entry, change
its billing status, or establish duration. The agent must warn that a changed
narrative may appear on a client-facing bill.

## Clio safety controls

Narrative updates are dry-run first. A production update requires Ron to
review and expressly confirm the exact proposal, including the matter, date,
lawyer, duration, rate, billing status, existing and revised narrative, and
supporting evidence. The entry must be an exact unbilled TimeEntry and the
current ETag must match. Billed, invoiced, written-off, deleted, unsupported,
or ambiguous entries remain out of scope.

The agent must not use a marker to reconstruct unsupported time or bypass the
billed-entry exclusion. Deletion, billing-status changes, invoice/payment
mutations, and broad legacy writes remain unavailable.

CSV generation remains a separate reviewed handoff. It includes only rows Ron
has expressly approved, uses the current Clio import template, and performs no
automatic upload or import.
