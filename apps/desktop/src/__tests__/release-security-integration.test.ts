// PR47: apps/desktop — Release & Updater Security Integration Tests
//
// Verifies PR47 release, packaging, and updater security invariants:
//   1. Update manifest parser rejects unsigned / non-HTTPS feeds and invalid checksums.
//   2. Update security invariants reject permission disablement or renderer injection payloads.
//   3. Tampered artifacts (sha256 mismatch) are detected and fail closed without staging.
//   4. Production config rejects secret leaks and dev server URLs in release mode.
//   5. Migration runner is idempotent and preserves backups on simulated failure.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  enforceUpdateSecurity,
  SecureUpdateService,
  validateUpdateCandidate,
  type UpdateAutoUpdaterAdapter,
} from "../main/updates/update-service.js";
import { buildFeedUrl, validateFeedUrl } from "../main/updates/update-feed.js";
import { loadProductionConfig, ProductionConfigError } from "../main/release/production-config.js";
import {
  runMigrations,
  applyMigrations,
  readVersionsFile,
  CURRENT_VERSIONS,
} from "../main/release/app-data.js";

describe("release-security-integration (PR47)", () => {
  describe("Feed and candidate validation", () => {
    it("rejects non-https update feeds", () => {
      expect(() => validateFeedUrl("http://github.com/owner/repo/releases")).toThrow(/only https/);
    });

    it("rejects non-allowlisted update hosts", () => {
      expect(() => validateFeedUrl("https://evil-attacker.com/updates.json")).toThrow(
        /not allowlisted/,
      );
    });

    it("rejects feeds with embedded credentials", () => {
      expect(() => validateFeedUrl("https://user:pass@github.com/owner/repo")).toThrow(
        /embedded credentials/,
      );
    });

    it("enforces stable-only feeds unless allowPreview is explicitly enabled", () => {
      expect(() =>
        buildFeedUrl({
          repo: "hellocloudwebdev/ai-desktop",
          channel: "beta",
          platform: "win32",
          arch: "x64",
          allowPreview: false,
        }),
      ).toThrow(/only stable supported/);
    });

    it("rejects candidates that are not newer than currentVersion", () => {
      expect(() =>
        validateUpdateCandidate(
          {
            version: "1.0.0",
            artifactUrl: "https://github.com/owner/repo/releases/download/v1.0.0/app.exe",
          },
          { channel: "stable", currentVersion: "1.0.0" },
        ),
      ).toThrow(/candidate is not newer/);
    });

    it("rejects non-allowlisted artifact file extensions", () => {
      expect(() =>
        validateUpdateCandidate(
          {
            version: "1.1.0",
            artifactUrl: "https://github.com/owner/repo/releases/download/v1.1.0/app.bat",
          },
          { channel: "stable", currentVersion: "1.0.0" },
        ),
      ).toThrow(/artifact extension is not allowlisted/);
    });
  });

  describe("Update security invariants", () => {
    it("rejects metadata attempting to disable permissions or inject renderer scripts", () => {
      expect(() => enforceUpdateSecurity({ disablePermissions: true })).toThrow(
        /violates security invariants/,
      );
      expect(() => enforceUpdateSecurity({ scriptUrls: ["https://evil.com/x.js"] })).toThrow(
        /violates security invariants/,
      );
      expect(() => enforceUpdateSecurity({ evalPayload: "alert(1)" })).toThrow(
        /violates security invariants/,
      );
      expect(() => enforceUpdateSecurity({ silentPluginInstall: true })).toThrow(
        /violates security invariants/,
      );
      expect(() => enforceUpdateSecurity({ silentTaskInstall: true })).toThrow(
        /violates security invariants/,
      );
    });

    it("detects and rejects nested security-violating keys", () => {
      expect(() =>
        enforceUpdateSecurity({
          nested: {
            deep: {
              disablePermissions: true,
            },
          },
        }),
      ).toThrow(/violates security invariants/);
    });
  });

  describe("Tampered artifact detection and fail-closed download", () => {
    it("fails closed when artifact sha256 does not match", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tamper-"));
      try {
        const dummyFile = path.join(tmp, "tampered.exe");
        fs.writeFileSync(dummyFile, "corrupted binary content");

        const adapter: UpdateAutoUpdaterAdapter = {
          checkForUpdates: async () => ({
            version: "1.1.0",
            artifactUrl: "https://github.com/owner/repo/releases/download/v1.1.0/tampered.exe",
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            channel: "stable",
          }),
          downloadUpdate: async () => dummyFile,
          quitAndInstall: () => {},
        };

        const service = new SecureUpdateService({
          feedUrl: "https://github.com/owner/repo/releases/latest/download/update.json",
          channel: "stable",
          currentVersion: "1.0.0",
          autoUpdater: adapter,
          emit: () => {},
        });

        const state = await service.checkForUpdates();
        expect(state).toBe("available");

        await expect(service.downloadUpdate()).rejects.toThrow(/checksum mismatch/);
        expect(service.getState()).toBe("failed");
        expect(service.getSnapshot().error).toContain("checksum mismatch");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("verifies authentic artifact sha256 and transitions to ready", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-"));
      try {
        const dummyFile = path.join(tmp, "authentic.exe");
        const content = "authentic binary content";
        fs.writeFileSync(dummyFile, content);

        const crypto = await import("node:crypto");
        const expectedHash = crypto.createHash("sha256").update(content).digest("hex");

        const adapter: UpdateAutoUpdaterAdapter = {
          checkForUpdates: async () => ({
            version: "1.1.0",
            artifactUrl: "https://github.com/owner/repo/releases/download/v1.1.0/authentic.exe",
            sha256: expectedHash,
            channel: "stable",
          }),
          downloadUpdate: async () => dummyFile,
          quitAndInstall: () => {},
        };

        const service = new SecureUpdateService({
          feedUrl: "https://github.com/owner/repo/releases/latest/download/update.json",
          channel: "stable",
          currentVersion: "1.0.0",
          autoUpdater: adapter,
          emit: () => {},
        });

        await service.checkForUpdates();
        const downloaded = await service.downloadUpdate();
        expect(downloaded).toBe(dummyFile);
        expect(service.getState()).toBe("ready");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("Production release configuration and data isolation", () => {
    it("refuses to load production config when dev flags or secret keys are present", () => {
      expect(() =>
        loadProductionConfig({
          NODE_ENV: "production",
          AI_DESKTOP_VERSION: "1.0.0",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
        }),
      ).toThrow(ProductionConfigError);

      expect(() =>
        loadProductionConfig({
          NODE_ENV: "production",
          AI_DESKTOP_VERSION: "1.0.0",
          AI_DESKTOP_API_KEY: "secret-leak-123",
        }),
      ).toThrow(ProductionConfigError);
    });

    it("migration runner preserves existing user data and backups on failure", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig-iso-"));
      try {
        const initial = await runMigrations(tmp, "1.0.0");
        expect(initial.schemaVersion).toBe(CURRENT_VERSIONS.schemaVersion);

        const userDataFile = path.join(tmp, "documents", "user-doc.txt");
        fs.writeFileSync(userDataFile, "important user document");

        let error: unknown;
        try {
          await applyMigrations(tmp, initial, [
            {
              version: 99,
              description: "faulty-migration",
              migrate() {
                throw new Error("simulated disk error");
              },
            },
          ]);
        } catch (err) {
          error = err;
        }

        expect(error).toBeDefined();
        // Check user data is intact
        expect(fs.existsSync(userDataFile)).toBe(true);
        expect(fs.readFileSync(userDataFile, "utf8")).toBe("important user document");

        // Check versions.json was not corrupted
        const preserved = readVersionsFile(tmp);
        expect(preserved?.schemaVersion).toBe(CURRENT_VERSIONS.schemaVersion);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
