import { z } from "zod";

export const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const dateSchema = z.iso.date();
export const timestampSchema = z.iso.datetime();
export const revisionSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
export const quantitySchema = z.int().min(0).max(1000);
export const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const commandMetaSchema = z.strictObject({ idempotencyKey: idempotencyKeySchema });
export const pageShape = {
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.int().min(1).max(100).default(25),
};
export const errorSchema = z.strictObject({
  code: z.string(), message: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  retryable: z.boolean(),
});
export const resultMetaSchema = z.strictObject({ requestId: z.string(), stateRevision: revisionSchema.optional() });
export function resultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data, meta: resultMetaSchema }),
    z.strictObject({ ok: z.literal(false), error: errorSchema, meta: z.strictObject({ requestId: z.string() }) }),
  ]);
}
export type Result<T> =
  | { ok: true; data: T; meta: { requestId: string; stateRevision?: number } }
  | { ok: false; error: z.infer<typeof errorSchema>; meta: { requestId: string } };
export interface SellerContext { sellerId: string; userId: string; requestId: string; sessionCreatedAt?: string }
export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly retryable = false) {
    super(message);
    this.name = "AppError";
  }
}
