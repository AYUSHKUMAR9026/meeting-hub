import { PermanentError } from '../../lib/errors';
import type { LlmProvider } from './provider';
import {
  chunkByBudget,
  extractionJsonSchema,
  extractionSchema,
  guardCitations,
  mergeItems,
  promptFor,
  repairExtraction,
  summaryJsonSchema,
  summarySchema,
  systemPrompt,
  type Extraction,
  type SourceSegment,
} from './extraction';

/** Standalone quality check: shares production prompts, schema guards and map/reduce functions. */
export async function extractLiveCheck(
  provider: LlmProvider,
  sources: SourceSegment[],
  signal: AbortSignal,
) {
  let itemsSeen = 0;
  let itemsValid = 0;
  let lowConfidence = false;
  const budget = provider.contextBudget ?? 24000;
  const chunks = chunkByBudget(
    sources,
    budget -
      Buffer.byteLength(promptFor('extract', { glossary: [], segments: [] }) + systemPrompt) -
      2000,
  );
  const partials: Extraction[] = [];
  for (const chunk of chunks) {
    const base = promptFor('extract', { glossary: [], segments: chunk });
    let prompt = base;
    let valid: Extraction | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const usage = await provider.generateStructured(prompt, extractionJsonSchema, {
        signal,
        task: 'extract',
        segmentIndexes: chunk.map((row) => row.idx),
      });
      const parsed = extractionSchema.safeParse(usage.result);
      valid = parsed.success ? parsed.data : attempt === 1 ? repairExtraction(usage.result) : null;
      if (valid) {
        if (attempt) lowConfidence = true;
        break;
      }
      prompt = `${base}\nCorrect the schema validation errors; return only matching JSON.`;
    }
    if (!valid)
      throw new PermanentError(
        'ANALYSIS_INVALID_OUTPUT',
        'The provider returned invalid meeting analysis twice.',
      );
    const guarded = guardCitations(valid, new Set(chunk.map((row) => row.idx)));
    itemsSeen += valid.decisions.length + valid.action_items.length;
    itemsValid += guarded.decisions.length + guarded.action_items.length;
    if (JSON.stringify(valid) !== JSON.stringify(guarded)) lowConfidence = true;
    partials.push(guarded);
  }
  let summaries = partials.map((partial) => partial.summary);
  while (summaries.length > 1) {
    const groups = chunkByBudget(summaries, budget - 4000);
    if (groups.length === summaries.length)
      throw new PermanentError(
        'ANALYSIS_CONTEXT_LIMIT',
        'The partial summaries exceed the context budget.',
      );
    const next = [];
    for (const group of groups) {
      if (group.length === 1) {
        next.push(group[0]!);
        continue;
      }
      let prompt = promptFor('summarize', group);
      let result = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const generated = await provider.generateStructured(prompt, summaryJsonSchema, {
          signal,
          task: 'summarize',
          segmentIndexes: [],
        });
        const parsed = summarySchema.safeParse(generated.result);
        if (parsed.success) {
          result = parsed.data;
          break;
        }
        prompt += '\nCorrect the schema validation errors and return only matching JSON.';
        lowConfidence = true;
      }
      if (!result)
        throw new PermanentError(
          'ANALYSIS_INVALID_OUTPUT',
          'The provider returned invalid summary JSON twice.',
        );
      next.push(result);
    }
    summaries = next;
  }
  return {
    summary: summaries[0] ?? { paragraph: 'No speech was detected.', bullets: [] },
    decisions: mergeItems(partials.flatMap((p) => p.decisions)),
    actionItems: mergeItems(partials.flatMap((p) => p.action_items)),
    citationValidityRate: itemsSeen ? itemsValid / itemsSeen : 1,
    itemsDropped: itemsSeen - itemsValid,
    lowConfidence,
  };
}
