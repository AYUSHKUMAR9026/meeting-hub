# ADR 0007 — Meeting document review, export and sharing

Accepted for Phase 7.

## Context

Phase 6 produces a summary and cited decisions and action items. Meeting participants need a portable document, revocable sharing with people outside their workspace, and an overview of decisions and action items from current documents.

## Decision

- Export from the current completed document. A document's optional transcript comes from that document's cited revision. Standalone TXT and SRT use the current transcript. Attachments use sanitised ASCII names and timestamps instead of segment URLs. Rejected and deleted items are omitted, and proposed decisions are labelled Unconfirmed.
- Use `mdast-util-to-markdown` for CommonMark, `docx` for Word, and `pdfmake` with its bundled Roboto fonts for PDF. Render simple UTF-8 TXT and SRT directly and escape SRT formatting markup. No renderer resolves user URLs or markup. The PDF font covers the scripts supported by bundled Roboto. Word, Markdown and TXT preserve Unicode source text.
- Generate on request. Bound source and attachment size with `EXPORT_MAX_BYTES` and enforce a 15-second generation deadline. Buffer the bounded attachment before streaming it so an oversized or failed render returns a problem response before headers. Record format, transcript inclusion and actor in audit.
- Store SHA-256 hashes of random 256-bit capability tokens. Each link has a required expiration of up to 90 days. Deployments may lower that cap. Owners and admins manage links for any meeting, and members manage links for their own meetings. The full URL is returned only on creation. Anonymous views have a per-IP rate limit and advisory no-index, no-store and no-referrer headers. The public projection includes the current document and optionally its speaker-labelled transcript with generic speaker labels. It removes email addresses, internal IDs and media URLs. Audit shares by ID and never log a URL containing a token.
- Disabling sharing in workspace settings suspends existing links while the setting is off. Re-enabling restores links that have not expired or been revoked. Closing a meeting makes its links inaccessible immediately and purge deletes them by a compound same-workspace cascade.
- Track items from current documents at workspace scope. Use stable sorted, bounded offset pagination, escaped literal text matching, and workspace-scoped person filters. Evidence links go to the first cited segment. Quick status changes use the same permissions and audit paths as meeting edits. Bulk proposed-decision updates lock the current document and apply atomically. Revisions remain independently readable.
- `exports.enabled`, `sharing.enabled`, and `review.enabled` default to off and can be set per workspace or overridden in the environment. The review flag gates both the tracker and additional document controls.

## Consequences

Each export reflects the snapshot assembled during its request. Shared links reflect the current completed summary and may show a newer revision after reprocessing. Anyone holding an active URL can read the chosen scope. There are no persisted export files or new queues.
