import { z } from "zod";
import { evidenceSpanSchema } from "@/lib/contracts/records";

export const intentLabels = ["pause", "resume", "quantity_change", "recurring_change", "multi_intent", "unsupported", "unclear", "no_change"] as const;
export const intentSchema = z.enum(intentLabels);
export const extractionCandidateSchema = z.strictObject({
  kind: z.enum(["pause", "resume", "quantity_change", "recurring_change", "unsupported", "unclear"]),
  evidence: z.array(z.strictObject({ ...evidenceSpanSchema.shape, quote: z.string().min(1).max(1000) }).refine((span) => span.start < span.end)).min(1).max(4),
  datePhrase: z.string().min(1).max(100).nullable(), endDatePhrase: z.string().min(1).max(100).nullable(),
  quantity: z.int().min(0).max(1000).nullable(), missingFields: z.array(z.string().min(1).max(200)).max(20),
});
export const extractionSchema = z.strictObject({ candidates: z.array(extractionCandidateSchema).max(20), clarification: z.string().max(500).nullable() });
const probability = z.number().finite().min(0).max(1);
export const jevResultSchema = z.strictObject({
  model: z.string().min(4).max(200),
  answers: z.strictObject({
    intent: z.strictObject({ type: z.literal("choice"), choice: intentSchema, probabilities: z.record(intentSchema, probability), confidence: probability }),
    explicitReplacement: z.strictObject({ type: z.literal("noul"), noul: probability }),
    clarity: z.strictObject({ type: z.literal("score"), score: z.number().finite(), legend: z.record(z.string().min(1).max(20), z.string().min(1).max(200)), probabilities: z.record(z.string().min(1).max(20), probability), confidence: probability }),
  }), usage: z.strictObject({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative() }),
}).superRefine((value, ctx) => {
  for (const answer of [value.answers.intent, value.answers.clarity]) {
    const sum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 0.02) ctx.addIssue({ code: "custom", message: "Invalid probability distribution" });
  }
  const clarity = value.answers.clarity;
  const scale = Object.keys(clarity.legend).map(Number);
  // JEV Scores can be fractional; validate against the returned scale, not an array/legend index.
  if (scale.length < 2 || scale.some((level) => !Number.isFinite(level)) || clarity.score < Math.min(...scale) || clarity.score > Math.max(...scale) || Object.keys(clarity.probabilities).some((key) => !Object.hasOwn(clarity.legend, key))) ctx.addIssue({ code: "custom", message: "Score legend does not match scores" });
});
export type Extraction = z.infer<typeof extractionSchema>;
export type ExtractionCandidate = z.infer<typeof extractionCandidateSchema>;
export type JevResult = z.infer<typeof jevResultSchema>;
export function validateExtractionEvidence(value: unknown, text: string): Extraction {
  const extraction = extractionSchema.parse(value);
  for (const candidate of extraction.candidates) {
    for (const evidence of candidate.evidence) {
      if (evidence.end > text.length || text.slice(evidence.start, evidence.end) !== evidence.quote) throw new Error("Evidence does not match original source");
    }
    for (const phrase of [candidate.datePhrase, candidate.endDatePhrase]) {
      if (phrase !== null && !candidate.evidence.some((evidence) => evidence.quote.includes(phrase))) throw new Error("Date phrase is not original evidence");
    }
  }
  return extraction;
}
