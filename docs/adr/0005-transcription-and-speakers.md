# ADR 0005: Transcription and speaker labels

- **Status:** Accepted

## Context

Phase 4 produces normalized audio and waveform peaks. Phase 5 turns the audio into timestamped,
speaker-labelled text and lets workspace owners and admins map those labels to directory entries.
The pipeline does not infer real names or call an LLM.

## Decision

- Keep pipeline v1 as `[prepare_media]`. When `transcription.enabled` is on for the workspace,
  new runs use v2, `[prepare_media, transcribe]`. The chosen version stays with the run. Owners
  and admins can start from `transcribe` when normalized audio already exists.
- Stream the normalized recording from S3 to AssemblyAI's upload endpoint. The provider's own
  upload URL is then used to request speaker diarization. Use the workspace language when set,
  otherwise auto-detect. Pass up to 200 glossary entries as Universal-2 keyterms. The local fake provider
  consumes the same stream and returns deterministic fixture text and labels.
- Store the provider job receipt in a pending transcript, and move the step to `waiting_external`
  in the same transaction. Reuse the deterministic BullMQ job on the transcription queue and move
  it to delayed between polls. Ordinary polling does not spend a retry attempt. The sweeper
  re-enqueues a lost poll. The deadline is two minutes plus twice the normalized audio duration,
  measured from the step's first attempt. HTTP 408, 429, 5xx and network failures retry with
  backoff. A terminal provider job that failed transiently is submitted again. Invalid input, rejected language and credentials fail with a user-safe error.
- Insert the new speakers and segments and switch the meeting's current transcript in the
  transaction that completes the step. A partial unique index enforces one current transcript.
  Pending and failed reprocesses leave the old transcript in place. A failed transcription
  preserves the normalized audio and reports a failed run. New transcript revisions start with
  provider labels because the provider can assign different labels on each run.
- Enforce workspace boundaries with composite foreign keys. Transcript and processing rows
  cascade when a meeting is purged. Deleting a person unlinks the speaker without deleting their
  text. Migration 0004 uses PostgreSQL's column-specific `ON DELETE SET NULL (person_id)`, which
  Drizzle's schema API cannot express directly.
- Workspace readers can page through or search the current transcript. The search route takes a
  JSON body so private search terms stay out of request URLs. Owners and admins can rename and link
  speakers. Logs and audits carry IDs and error codes, never utterances, transcript content or
  provider error bodies.

[AssemblyAI submission API](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit)

## Operational tradeoffs

- If the worker dies after the provider accepts a submission and before Postgres saves the job
  receipt, a retry may submit a second external job. Once a receipt is saved, retries and lost
  queue deliveries resume the same job. The provider API does not participate in the database
  transaction.
- Meeting purge removes local transcript data and recordings. Provider-side copies follow the
  provider account's retention policy. Enable the AssemblyAI provider only for workspaces whose
  audio can be sent to that service.
- The fake provider is for development and automated tests. TXT/SRT export is left out of this
  phase. No analysis, extraction, indexing or other Phase 6 work is included.
