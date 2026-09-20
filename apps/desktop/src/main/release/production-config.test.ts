// apps/desktop — Production configuration gate tests.

import { describe, expect, it } from "vitest";
import { ProductionConfigError, loadProductionConfig } from "./production-config.js";

function devEnv(): NodeJS.ProcessEnv {
  return { NODE_ENV: "development" };
}

function prodEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    AI_DESKTOP_VERSION: "1.2.3",
    ...overrides,
  };
}

describe("release: production config", () => {
  it("passes dev environments through without throwing", () => {
    const loaded = loadProductionConfig(devEnv());
    expect(loaded.isProduction).toBe(false);
    expect(loaded.config.build.version).toBe("0.0.0-dev");
    expect(loaded.config.runtime.logLevel).toBe("info");
    expect(loaded.config.user.autoUpdates).toBe(true);
  });

  it("loads a valid production environment", () => {
    const loaded = loadProductionConfig(prodEnv());
    expect(loaded.isProduction).toBe(true);
    expect(loaded.config.build.version).toBe("1.2.3");
    expect(loaded.config.build.channel).toBe("stable");
  });

  it("rejects VITE_DEV_SERVER_URL in production without echoing it", () => {
    const secretValue = "sh0uld-never-appear-in-errors";
    let caught: unknown;
    try {
      loadProductionConfig(
        prodEnv({ VITE_DEV_SERVER_URL: `http://localhost:5173/${secretValue}` }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).code).toBe("DEV_FLAG_PRESENT");
    expect(String((caught as Error).message)).not.toContain(secretValue);
  });

  it("rejects DEBUG in production without echoing its value", () => {
    let caught: unknown;
    try {
      loadProductionConfig(prodEnv({ DEBUG: "super-secret-debug-flag" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).code).toBe("DEV_FLAG_PRESENT");
    expect(String((caught as Error).message)).not.toContain("super-secret-debug-flag");
  });

  it("refuses secret-bearing keys instead of reading them", () => {
    let caught: unknown;
    try {
      loadProductionConfig(prodEnv({ AI_DESKTOP_API_KEY: "sk-ant-topsecret" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).code).toBe("SECRET_KEYS_PRESENT");
    expect(String((caught as Error).message)).not.toContain("sk-ant-topsecret");
    expect(String((caught as Error).message)).not.toContain("AI_DESKTOP_API_KEY");
  });

  it("rejects unknown channels with a value-free message", () => {
    let caught: unknown;
    try {
      loadProductionConfig(prodEnv({ AI_DESKTOP_CHANNEL: "canary" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProductionConfigError);
    expect((caught as ProductionConfigError).code).toBe("INVALID_CONFIG");
    expect(String((caught as Error).message)).not.toContain("canary");
  });

  it("rejects missing version and non-https feeds without env dumps", () => {
    let missingVersion: unknown;
    try {
      loadProductionConfig({ NODE_ENV: "production" });
    } catch (error) {
      missingVersion = error;
    }
    expect(missingVersion).toBeInstanceOf(ProductionConfigError);

    let badFeed: unknown;
    try {
      loadProductionConfig(prodEnv({ AI_DESKTOP_UPDATE_FEED_URL: "http://insecure.example/feed" }));
    } catch (error) {
      badFeed = error;
    }
    expect(badFeed).toBeInstanceOf(ProductionConfigError);
    expect(String((badFeed as Error).message)).not.toContain("insecure.example");
  });
});
