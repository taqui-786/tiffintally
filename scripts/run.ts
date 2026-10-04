import { AppError } from "../lib/contracts/common";
import { closeDb } from "../lib/server/db/client";

export async function run(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(error instanceof AppError ? `${error.code}: ${error.message}` : "Backend command failed. Check configuration and database access; private error details are omitted.");
    process.exitCode = 1;
  } finally {
    await closeDb().catch(() => { process.exitCode = 1; });
  }
}
