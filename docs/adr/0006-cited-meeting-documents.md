# ADR 0006: Cited meeting documents

- **Status:** Accepted

Pipeline v3 appends `analyze` to the immutable v2 pipeline when both transcription and analysis
are enabled. `POST /v1/meetings/{id}/runs` with `fromStep: analyze` reuses the current transcript.
A terminal analysis failure sets both run and meeting to `partially_ready`, retaining audio,
transcript, and any previous document.

The analysis worker sends a constrained JSON schema to Anthropic, validates the result with Zod,
and allows one correction containing only issue paths and codes. No tools are enabled. Transcript
segments, speaker names, and glossary terms are escaped JSON in an explicitly untrusted prompt
section. Each decision and action item requires at least one valid source index from its chunk.
The worker links items to actual segment UUIDs. Speaker references must resolve unambiguously to
an existing transcript speaker before they can link to a person. Up to 60 workspace glossary
terms are included per extraction request.

The worker splits at segment boundaries, deduplicates items and unions citations, and reduces
partial summaries in bounded batches. Postgres checkpoints validated responses and reserves the
conservative UTF-8 input budget before every request, including retries. Actual input and output
usage is recorded separately. A process crash between a provider response and its checkpoint can
repeat the request, within the reserved budget. The step deadline scales with transcript size.
Logs exclude source text, prompt payloads, provider responses, and extracted meeting content.
[Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

The completed document, items, evidence and current pointer commit together. Earlier completed
documents remain readable, including human edits. They are immutable after replacement, and
version history identifies revisions with edits. New model output is stored as a separate
revision. The Summary tab links citations to the original transcript revision and segment.
Manual additions require a citation. Members can edit items on meetings they created, and
owners and admins can edit across their workspace.

Composite foreign keys scope items and evidence to the workspace, document, and source transcript.
Generated reference columns enforce the two evidence item types in PostgreSQL. Migration 0005
uses column-specific nulling for deleted speaker and person links. Meeting purge removes all
document revisions and related rows through cascade.
