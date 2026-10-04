import "server-only";
import { MongoClient } from "mongodb";
import { getDatabaseConfig } from "@/lib/server/env";

let connection: Promise<MongoClient> | undefined;

export async function getClient(): Promise<MongoClient> {
  if (!connection) {
    const { uri } = getDatabaseConfig();
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      timeoutMS: 15_000,
    });
    connection = client.connect().catch(async (error: unknown) => {
      connection = undefined;
      await client.close();
      throw error;
    });
  }
  return connection;
}

export async function getDb() {
  return (await getClient()).db(getDatabaseConfig().dbName);
}

export async function closeDb(): Promise<void> {
  const current = connection;
  connection = undefined;
  if (current) await (await current).close();
}
