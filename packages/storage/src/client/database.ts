// PR8: packages/storage — Controlled Prisma Client & WAL Lifecycle
//
// Architectural Invariants:
//   - Prisma is used exclusively behind this storage abstraction.
//   - SQLite must run with journal_mode = WAL.
//   - Controlled database lifecycle: one central access mechanism, explicit connect/disconnect.
//   - WAL mode is actively verified at runtime via PRAGMA journal_mode.

import { PrismaClient } from "@prisma/client";

export interface DatabaseOptions {
  /**
   * Optional custom database connection URL (e.g. "file:./dev.db" or in-memory for testing).
   * Defaults to process.env.DATABASE_URL.
   */
  readonly url?: string;
  /**
   * Optional custom logging options for Prisma queries and errors.
   */
  readonly log?: ("query" | "info" | "warn" | "error")[];
}

export class StorageDatabase {
  private readonly _client: PrismaClient;
  private _isInitialized = false;
  private readonly _url?: string;

  constructor(options?: DatabaseOptions) {
    this._url = options?.url;
    this._client = new PrismaClient({
      datasourceUrl: options?.url,
      log: options?.log,
    });
  }

  /**
   * Internal PrismaClient reference, accessible only to storage repositories.
   */
  get client(): PrismaClient {
    return this._client;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  get url(): string | undefined {
    return this._url;
  }

  /**
   * Initializes the database connection and activates SQLite WAL mode.
   * Runs PRAGMA journal_mode = WAL and verifies the active journal mode.
   */
  async initialize(): Promise<void> {
    if (this._isInitialized) {
      return;
    }

    await this._client.$connect();

    // Activate and verify WAL mode via $queryRawUnsafe
    // Note: In SQLite, "PRAGMA journal_mode = WAL;" returns the resulting mode as a result row,
    // which causes $executeRawUnsafe to fail with "Execute returned results, which is not allowed in SQLite".
    const walRows = await this._client.$queryRawUnsafe<Array<{ journal_mode: string }>>(
      "PRAGMA journal_mode = WAL;",
    );
    const walResult =
      walRows && walRows.length > 0 && walRows[0].journal_mode
        ? walRows[0].journal_mode.toLowerCase()
        : await this.getJournalMode();

    if (walResult !== "wal") {
      // In-memory or temporary databases might fall back to 'memory', but on-disk SQLite must be 'wal'
      if (!this._url?.includes(":memory:") && !this._url?.includes("mode=memory")) {
        console.warn(`[StorageDatabase] SQLite journal_mode is "${walResult}" instead of "wal"`);
      }
    }

    // Set synchronous to NORMAL for optimal WAL durability and performance
    await this._client.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");

    this._isInitialized = true;
  }

  /**
   * Executes "PRAGMA journal_mode;" directly against the active SQLite database
   * and returns the current journal mode string (e.g. "wal").
   */
  async getJournalMode(): Promise<string> {
    const rows =
      await this._client.$queryRawUnsafe<Array<{ journal_mode: string }>>("PRAGMA journal_mode;");
    if (!rows || rows.length === 0 || !rows[0].journal_mode) {
      throw new Error("Unable to determine SQLite journal_mode via PRAGMA query");
    }
    return rows[0].journal_mode.toLowerCase();
  }

  /**
   * Disconnects the Prisma client cleanly.
   */
  async close(): Promise<void> {
    await this._client.$disconnect();
    this._isInitialized = false;
  }
}
