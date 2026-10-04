import { z } from "zod";
import { operationSchemas, outputSchemas } from "./api";
import { intelligenceInputSchemas, intelligenceOutputSchemas, analysisRunViewSchema } from "./intelligence";
import { historyInputSchemas, historyOutputSchemas, forecastRunSchema } from "./history";
import { privacyInputSchemas, privacyOutputSchemas, privacyOperationSchema } from "./privacy";
import { receiptSchema } from "./records";
import { commerceInputSchemas, commerceOutputSchemas } from "./commerce";
export const backendInputSchemas = { ...operationSchemas, ...intelligenceInputSchemas, ...historyInputSchemas, ...privacyInputSchemas, ...commerceInputSchemas } as const;
export const backendOutputSchemas = {
  ...outputSchemas, ...intelligenceOutputSchemas, ...historyOutputSchemas, ...privacyOutputSchemas, ...commerceOutputSchemas,
  me: outputSchemas.me.extend({ capabilities: outputSchemas.me.shape.capabilities.extend({ ai: z.boolean() }) }),
  getReceipt: z.union([receiptSchema, analysisRunViewSchema, forecastRunSchema, privacyOperationSchema]),
} as const;
export type BackendOperationName = keyof typeof backendInputSchemas;
export type BackendInput<K extends BackendOperationName> = z.infer<(typeof backendInputSchemas)[K]>;
export type BackendOutput<K extends BackendOperationName> = z.infer<(typeof backendOutputSchemas)[K]>;
