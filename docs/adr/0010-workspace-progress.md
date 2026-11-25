# ADR 0010: Workspace progress from meeting documents

Status: Accepted

## Decision

The progress module reads current meeting documents and stores one aggregate observation per
workspace calendar date. Use the existing maintenance queue, transactional outbox, feature flags,
workspace authorization and PostgreSQL; no paid service is required.

Migration **0009** implements this phase: 0008 is already committed for Phase 9 and must not be
renumbered or rewritten. The two aggregate/event tables have UUIDv7 IDs. A small durable refresh
request table coalesces notifications. Composite item/workspace and meeting/workspace foreign keys
prevent cross-tenant event references. All tenant-owned tables cascade on workspace deletion.

## Metric definitions

- Open/done: nondeleted action items on current documents of nondeleted meetings, by status.
- Overdue: open actions whose date-only due date is strictly before today's workspace date.
- Completion: `100 * done / (open + done)`, rounded to one decimal; zero for an empty denominator.
- Rejected: separately reported diagnostic total; excluded from active items and completion.
- Proposed/confirmed decisions: nondeleted current decisions in that status. Proposed count is
  the same as decisions proposed because the existing action status model has no proposed state.
- Meeting count: nondeleted meetings, including those without documents. Meeting recaps show
  nonrejected decisions/actions and action completion, newest occurrence first.
- Owners: prefer explicit person, then a speaker's linked person, then the document's speaker ID,
  then unassigned. Never merge unnamed speakers across revisions or meetings by label alone.
- Carried over: current open actions from strictly earlier meetings with at least one shared
  directory participant. Shared participation is required; matching names is insufficient.
- Decision bars: creation/status transition events to proposed or confirmed during that bucket,
  including repeated confirmations after reopening. They are activity counts, not unique decisions.
- Weekly state uses the final observed day of the Monday-start calendar week. Activity and meetings
  sum within the selected range. No synthetic zero counts are inserted for unobserved dates.

Current summary totals cover all meeting dates (optional meeting/person scope). The selected range
controls historical charts and the comparison baseline: the latest persisted observation before the
range start. If no baseline exists, change is null. Filtered current views have no historical comparison.
Owner and meeting list date filters apply to meeting occurrence dates. Historical owner/meeting
filters return 400: workspace snapshots do not encode those dimensions and filtering today's
revisions would falsely rewrite history. This is a deliberate limitation of the requested schema.

## Time zones and history

Use IANA workspace time zones through Intl and PostgreSQL `AT TIME ZONE`. Date-only arithmetic
and Monday week boundaries operate on calendar dates, never by adding 24 hours to local midnight.
Day ranges are inclusive and at most 366 calendar days. Instants are filtered with half-open local
midnight bounds, so 23/25-hour daylight-saving days are handled correctly.

Only today's snapshot is upserted; previous dates are never recomputed by reprocessing. Today's
API point overlays live totals for immediate edits. Historical observations remain valid even if
the contributing document is superseded. A missing day during worker downtime remains missing:
there is insufficient information to reconstruct its complete state. Changing the workspace zone
does not re-label stored snapshot dates; future observations use the new zone.

On meeting purge, item status events cascade. Content-free historical workspace aggregates remain
as observations; today's totals exclude the deleted meeting. On workspace purge, snapshots, status
events and pending refresh requests all cascade. No snapshot stores content, names or meeting IDs.

Backfill creates a marked baseline today and marked status observations for existing items. Explicit
bulk-review audit status/IDs supply known decision change times. Legacy individual edit audits only
contain field names; they cannot prove completion times. An existing noninitial status without a
usable audit is observed at migration time, rather than inventing a completion date. Initial statuses
use document creation time. Backfilled does not mean a complete event history.

## Transactionality and maintenance

Database triggers write initial/status events in the item transaction, covering individual edits,
bulk review, manual inserts and pipeline publications. DocumentService sets a transaction-local
actor ID. Background writes have a null actor. Triggers also emit content-free `progress.changed`
outbox events for item edits, current document publication and meeting changes. The outbox consumer
always drains notifications into a refresh request, even while the feature is disabled: deferred
notifications would otherwise starve later recording events behind the dispatcher's bounded scan.
The flag gates aggregation, routes and UI. Requests are eligible after five seconds; bursts coalesce without
indefinite postponement. The maintenance scheduler checks a fair keyset page of 100 workspaces per
minute, refreshes dirty workspaces and creates an observation after local midnight. A complete
rotation takes `ceil(workspaces / 100)` minutes. Restart resets the cursor; missing snapshots and
Postgres refresh markers repair lost Redis deliveries. Advisory locks serialize workspace snapshots.

Every aggregation has a five-second local statement timeout. Read operations use a repeatable-read
transaction. Snapshot date queries use the unique workspace/date index; status activity uses the
workspace/time index; tracker indexes cover current item status, due date and owners. Results are
bounded to 366 days, 100 latest meetings, 1,000 owner groups and 500 items per recap section. The
recap reports truncation. Statement timeouts bound larger workspace aggregates.

## API, web and accessibility

The five read endpoints reuse workspace.read/meeting.read for all member roles and 404 across
workspaces. They are added to the authorization matrix. CSV exports only the timeseries columns,
quotes every cell, escapes quotes/newlines and protects spreadsheet formula prefixes. Export audit
metadata contains only row count and bucket. Responses are private/no-store. Errors keep the
existing problem+json contract. Never log transcript, summary, item text or exported content.

Use **Recharts 3.11.1 (MIT)**, pinned exactly; package version/license verified against npm metadata.
It uses React/SVG without external services. Distinct line dashes, bar patterns, text labels, accessible
data-table equivalents and print tables avoid color-only encoding. Keyboard users use table links.
Chart and table links open the current tracker with status, owner, speaker, unassigned, meeting or
item filters; historical links explicitly describe current items, since historical snapshots do not
store item membership. The page polls every 30 seconds and exposes a manual refresh. The meeting
panel polls every 15 seconds. Date/bucket changes preserve workspace timezone labels and errors.

`progress.enabled` defaults off and is client visible. Enable alongside existing analysis/review flags
for extraction and tracker links. Flag-off public behavior stays as Phase 9; passive event capture
continues so enabling the feature later does not lose status changes. No new environment variables.

## Consequences and deviations

Historical person/meeting slices and historical item-membership drilldown require additional
snapshot dimensions and are intentionally unsupported. The current tracker remains the source for
editable items. Existing audits cannot supply complete completion histories; backfill is explicitly
marked. Migration numbering follows the real repository rather than the prompt's occupied 0008.
No Phase 11 work is included.
