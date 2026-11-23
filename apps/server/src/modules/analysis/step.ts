import { createHash } from 'node:crypto';

import {
  actionItems,
  and,
  asc,
  decisions,
  eq,
  evidence,
  lte,
  meetingDocuments,
  people,
  sql,
  transcriptSegments,
  transcriptSpeakers,
  transcripts,
  workspaceSettings,
} from '@meeting-hub/db';
import type { z } from 'zod';

import type { Database, Transaction } from '../../lib/db';
import { PermanentError } from '../../lib/errors';
import type { RunRef, StepDefinition } from '../processing';
import {
  chunkByBudget,
  CONTEXT_BUDGET,
  extractionJsonSchema,
  extractionSchema,
  guardCitations,
  mergeItems,
  PROMPT_VERSION,
  promptFor,
  summaryJsonSchema,
  summarySchema,
  systemPrompt,
  type Extraction,
  type Summary,
} from './extraction';
import type { LlmOptions, LlmProvider } from './provider';

type Document = typeof meetingDocuments.$inferSelect;
type Segment = typeof transcriptSegments.$inferSelect;
type Speaker = { id: string; label: string; name: string; personId: string | null };
type SavedResult = { key: string; value: unknown };

const MAX_TIMEOUT = 20 * 60_000;
const budgetError = () =>
  new PermanentError(
    'ANALYSIS_INPUT_LIMIT',
    'The transcript exceeds the analysis input token budget.',
  );
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function withoutContent<T>(work: () => PromiseLike<T>): Promise<T> {
  try {
    return await work();
  } catch {
    // Drizzle errors may contain SQL parameters holding extracted meeting content.
    throw new Error('Could not persist the meeting analysis.');
  }
}

async function publish(
  tx: Transaction,
  document: Document,
  result: Extraction,
  segments: Segment[],
  speakers: Speaker[],
) {
  const { workspaceId, transcriptId, meetingId } = document;
  const documentId = document.id;
  const indexes = new Map(segments.map(({ idx, id }) => [idx, id]));
  const addEvidence = async (
    itemType: 'decision' | 'action_item',
    rows: { id: string; idx: number }[],
    items: { segment_idx: number[] }[],
  ) => {
    const links = rows.flatMap(({ id, idx }) =>
      items[idx]!.segment_idx.map((segment) => ({
        workspaceId,
        documentId,
        transcriptId,
        itemType,
        itemId: id,
        segmentId: indexes.get(segment)!,
      })),
    );
    for (let i = 0; i < links.length; i += 1000)
      await tx.insert(evidence).values(links.slice(i, i + 1000));
  };
  await withoutContent(async () => {
    if (result.decisions.length) {
      const rows = await tx
        .insert(decisions)
        .values(
          result.decisions.map(({ title, description, rationale }, idx) => ({
            workspaceId,
            documentId,
            transcriptId,
            idx,
            title,
            description,
            rationale,
          })),
        )
        .returning({ id: decisions.id, idx: decisions.idx });
      await addEvidence('decision', rows, result.decisions);
    }
    if (result.action_items.length) {
      const rows = await tx
        .insert(actionItems)
        .values(
          result.action_items.map(({ title, description, owner_speaker, due_date }, idx) => {
            const matches =
              owner_speaker === null
                ? []
                : speakers.filter((speaker) =>
                    [speaker.label, speaker.name].some(
                      (name) => name.toLowerCase() === owner_speaker.trim().toLowerCase(),
                    ),
                  );
            const owner = matches.length === 1 ? matches[0] : undefined;
            return {
              workspaceId,
              documentId,
              transcriptId,
              idx,
              title,
              description,
              dueDate: due_date,
              ownerSpeakerId: owner?.id ?? null,
              ownerPersonId: owner?.personId ?? null,
            };
          }),
        )
        .returning({ id: actionItems.id, idx: actionItems.idx });
      await addEvidence('action_item', rows, result.action_items);
    }
    await tx
      .update(meetingDocuments)
      .set({ isCurrent: false })
      .where(
        and(
          eq(meetingDocuments.workspaceId, workspaceId),
          eq(meetingDocuments.meetingId, meetingId),
          eq(meetingDocuments.isCurrent, true),
        ),
      );
    await tx
      .update(meetingDocuments)
      .set({
        isCurrent: true,
        status: 'completed',
        summary: result.summary,
        checkpoints: [],
      })
      .where(
        and(eq(meetingDocuments.workspaceId, workspaceId), eq(meetingDocuments.id, documentId)),
      );
  });
}

export function analyzeStep({
  db,
  provider,
  queue,
  maxInputTokens,
}: {
  db: Database;
  provider: LlmProvider;
  queue: string;
  maxInputTokens: number;
}): StepDefinition {
  const find = async (run: RunRef) => {
    const [document] = await db
      .select()
      .from(meetingDocuments)
      .where(
        and(
          eq(meetingDocuments.processingRunId, run.id),
          eq(meetingDocuments.workspaceId, run.workspaceId),
        ),
      );
    return document;
  };
  return {
    name: 'analyze',
    queue,
    runStatus: 'analyzing',
    maxAttempts: 4,
    timeoutMs: MAX_TIMEOUT,
    backoffMs: 2000,
    weight: 2,
    external: true,
    isAlreadyDone: async (run) => (await find(run))?.status === 'completed',
    async execute(ctx) {
      const { workspaceId, meetingId } = ctx.run;
      const previous = await find(ctx.run);
      const [transcript] = await db
        .select({ id: transcripts.id })
        .from(transcripts)
        .where(
          and(
            eq(transcripts.workspaceId, workspaceId),
            eq(transcripts.meetingId, meetingId),
            previous ? eq(transcripts.id, previous.transcriptId) : eq(transcripts.isCurrent, true),
            eq(transcripts.status, 'completed'),
          ),
        );
      if (!transcript)
        throw new PermanentError(
          'ANALYSIS_TRANSCRIPT_MISSING',
          'There is no transcript to analyze.',
        );
      const transcriptId = transcript.id;
      const [segments, roster, [settings]] = await Promise.all([
        db
          .select()
          .from(transcriptSegments)
          .where(
            and(
              eq(transcriptSegments.workspaceId, workspaceId),
              eq(transcriptSegments.transcriptId, transcriptId),
            ),
          )
          .orderBy(asc(transcriptSegments.idx)),
        db
          .select({
            id: transcriptSpeakers.id,
            label: transcriptSpeakers.label,
            displayName: transcriptSpeakers.displayName,
            personId: transcriptSpeakers.personId,
            personName: people.displayName,
          })
          .from(transcriptSpeakers)
          .leftJoin(
            people,
            and(eq(people.id, transcriptSpeakers.personId), eq(people.workspaceId, workspaceId)),
          )
          .where(
            and(
              eq(transcriptSpeakers.workspaceId, workspaceId),
              eq(transcriptSpeakers.transcriptId, transcriptId),
            ),
          ),
        db
          .select({ glossary: workspaceSettings.glossary })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId)),
      ]);
      const speakers = roster.map(({ id, label, displayName, personId, personName }) => ({
        id,
        label,
        name: displayName ?? personName ?? label,
        personId,
      }));
      const bySpeaker = new Map(speakers.map((speaker) => [speaker.id, speaker]));
      const sources = segments.map((segment) => {
        const speaker = bySpeaker.get(segment.speakerId)!;
        return { idx: segment.idx, speaker: speaker.label, name: speaker.name, text: segment.text };
      });
      const rawBytes = sources.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0);
      const deadlineAt = new Date(
        ctx.startedAt.getTime() + Math.min(MAX_TIMEOUT, 90_000 + rawBytes * 8),
      );
      const timeLeft = deadlineAt.getTime() - Date.now();
      const timedOut = new PermanentError(
        'STEP_TIMED_OUT',
        'Meeting analysis took too long and was stopped.',
      );
      if (timeLeft <= 0) throw timedOut;
      await ctx.setDeadline(deadlineAt);
      const timer = AbortSignal.timeout(timeLeft);
      const signal = AbortSignal.any([ctx.signal, timer]);
      if (rawBytes > maxInputTokens) throw budgetError();

      const document =
        previous ??
        (
          await db
            .insert(meetingDocuments)
            .values({
              workspaceId,
              meetingId,
              transcriptId,
              processingRunId: ctx.run.id,
              model: provider.model,
              promptVersion: PROMPT_VERSION,
            })
            .returning()
        )[0]!;
      if (document.model !== provider.model || document.promptVersion !== PROMPT_VERSION)
        throw new PermanentError(
          'ANALYSIS_CONFIGURATION_CHANGED',
          'Analysis settings changed. Start a new analysis run.',
        );
      const documentScope = and(
        eq(meetingDocuments.workspaceId, workspaceId),
        eq(meetingDocuments.id, document.id),
        eq(meetingDocuments.status, 'pending'),
      );
      const glossary = (settings?.glossary ?? []).slice(0, 60);
      const overhead =
        Buffer.byteLength(promptFor('extract', { glossary, segments: [] }) + systemPrompt) + 2000;
      const chunkBudget = CONTEXT_BUDGET - overhead;
      const chunks = chunkByBudget(sources, chunkBudget);
      const saved = new Map(
        (document.checkpoints as SavedResult[]).map(({ key, value }) => [key, value]),
      );

      async function generate<T>(
        prompt: string,
        shape: z.ZodType<T>,
        jsonSchema: Record<string, unknown>,
        options: Omit<LlmOptions, 'signal'>,
      ): Promise<T> {
        const key = hash(prompt);
        const previousResult = shape.safeParse(saved.get(key));
        if (previousResult.success) return previousResult.data;
        let currentPrompt = prompt;
        for (let attempt = 0; attempt < 2; attempt++) {
          await ctx.checkpoint();
          signal.throwIfAborted();
          const estimate =
            Buffer.byteLength(currentPrompt + systemPrompt + JSON.stringify(jsonSchema)) + 512;
          if (estimate > CONTEXT_BUDGET)
            throw new PermanentError(
              'ANALYSIS_CONTEXT_LIMIT',
              'Analysis input exceeds the per-request context budget.',
            );
          const [reserved] = await db
            .update(meetingDocuments)
            .set({ budgetTokens: sql`${meetingDocuments.budgetTokens} + ${estimate}` })
            .where(
              and(documentScope, lte(meetingDocuments.budgetTokens, maxInputTokens - estimate)),
            )
            .returning({ budgetTokens: meetingDocuments.budgetTokens });
          if (!reserved) {
            await ctx.checkpoint();
            throw budgetError();
          }
          const usage = await provider.generateStructured(currentPrompt, jsonSchema, {
            ...options,
            signal,
          });
          const validated = shape.safeParse(usage.result);
          const overrun = Math.max(0, usage.inputTokens - estimate);
          const checkpoint = validated.success ? [{ key, value: validated.data }] : [];
          const [charged] = await withoutContent(() =>
            db
              .update(meetingDocuments)
              .set({
                inputTokens: sql`${meetingDocuments.inputTokens} + ${usage.inputTokens}`,
                outputTokens: sql`${meetingDocuments.outputTokens} + ${usage.outputTokens}`,
                budgetTokens: sql`${meetingDocuments.budgetTokens} + ${overrun}`,
                checkpoints: sql`${meetingDocuments.checkpoints} || ${JSON.stringify(checkpoint)}::jsonb`,
              })
              .where(documentScope)
              .returning({ budgetTokens: meetingDocuments.budgetTokens }),
          );
          if (!charged || charged.budgetTokens > maxInputTokens) throw budgetError();
          if (validated.success) return validated.data;
          const issues = validated.error.issues
            .slice(0, 8)
            .map(({ path, code }) => `${path.map(String).join('.') || 'root'} (${code})`);
          currentPrompt = `${prompt}\nCorrect these schema validation errors: ${issues.join(', ')}. Return only matching JSON.`;
        }
        throw new PermanentError(
          'ANALYSIS_INVALID_OUTPUT',
          'The provider returned invalid meeting analysis twice.',
        );
      }

      try {
        const partials: Extraction[] = [];
        for (const [index, batch] of chunks.entries()) {
          ctx.progress(index / (chunks.length + 1), 'extracting meeting details');
          const segmentIndexes = batch.map(({ idx }) => idx);
          const partial = await generate(
            promptFor('extract', { glossary, segments: batch }),
            extractionSchema,
            extractionJsonSchema,
            { task: 'extract', segmentIndexes },
          );
          partials.push(guardCitations(partial, new Set(segmentIndexes)));
        }

        let summaries = partials.map(({ summary }) => summary);
        while (summaries.length > 1) {
          ctx.progress(0.9, 'combining meeting summaries');
          const groups = chunkByBudget(summaries, CONTEXT_BUDGET - 4000);
          if (groups.length === summaries.length)
            throw new PermanentError(
              'ANALYSIS_CONTEXT_LIMIT',
              'The partial summaries are too large to combine.',
            );
          const next: Summary[] = [];
          for (const group of groups) {
            next.push(
              group.length === 1
                ? group[0]!
                : await generate(promptFor('summarize', group), summarySchema, summaryJsonSchema, {
                    task: 'summarize',
                    segmentIndexes: [],
                  }),
            );
          }
          summaries = next;
        }

        const result = {
          summary: summaries[0] ?? {
            paragraph: 'No speech was detected in this recording.',
            bullets: [],
          },
          decisions: mergeItems(partials.flatMap((partial) => partial.decisions)).slice(0, 200),
          action_items: mergeItems(partials.flatMap((partial) => partial.action_items)).slice(
            0,
            200,
          ),
        };
        return {
          commit: ({ tx }) => publish(tx, document, result, segments, speakers),
          discard: () => Promise.resolve(),
        };
      } catch (error) {
        if (timer.aborted) throw timedOut;
        throw error;
      }
    },
  };
}
