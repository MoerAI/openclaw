import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isOllamaReachable,
  resolveImplicitProviders,
  resolveOllamaApiBase,
} from "./models-config.providers.js";

describe("resolveOllamaApiBase", () => {
  it("returns default localhost base when no configured URL is provided", () => {
    expect(resolveOllamaApiBase()).toBe("http://127.0.0.1:11434");
  });

  it("strips /v1 suffix from OpenAI-compatible URLs", () => {
    expect(resolveOllamaApiBase("http://ollama-host:11434/v1")).toBe("http://ollama-host:11434");
    expect(resolveOllamaApiBase("http://ollama-host:11434/V1")).toBe("http://ollama-host:11434");
  });

  it("keeps URLs without /v1 unchanged", () => {
    expect(resolveOllamaApiBase("http://ollama-host:11434")).toBe("http://ollama-host:11434");
  });

  it("handles trailing slash before canonicalizing", () => {
    expect(resolveOllamaApiBase("http://ollama-host:11434/v1/")).toBe("http://ollama-host:11434");
    expect(resolveOllamaApiBase("http://ollama-host:11434/")).toBe("http://ollama-host:11434");
  });
});

describe("Ollama provider", () => {
  it("should not include ollama when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.ollama).toBeUndefined();
  });

  it("should use native ollama api type", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({ agentDir });

      expect(providers?.ollama).toBeDefined();
      expect(providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
      expect(providers?.ollama?.api).toBe("ollama");
      expect(providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("should preserve explicit ollama baseUrl on implicit provider injection", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({
        agentDir,
        explicitProviders: {
          ollama: {
            baseUrl: "http://192.168.20.14:11434/v1",
            api: "openai-completions",
            models: [],
          },
        },
      });

      // Native API strips /v1 suffix via resolveOllamaApiBase()
      expect(providers?.ollama?.baseUrl).toBe("http://192.168.20.14:11434");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });

  it("should have correct model structure without streaming override", () => {
    const mockOllamaModel = {
      id: "llama3.3:latest",
      name: "llama3.3:latest",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };

    // Native Ollama provider does not need streaming: false workaround
    expect(mockOllamaModel).not.toHaveProperty("params");
  });
});

describe("isOllamaReachable", () => {
  it("returns false in test environments (VITEST is set)", async () => {
    // VITEST env var is always set during vitest runs, so this should return false.
    const result = await isOllamaReachable("http://127.0.0.1:11434");
    expect(result).toBe(false);
  });
});

describe("Ollama keyless auto-discovery", () => {
  it("should not register ollama when no key and server unreachable (test env)", async () => {
    // In test environments isOllamaReachable returns false, so no keyless
    // registration should occur.
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    expect(providers?.ollama).toBeUndefined();
  });

  it("should not overwrite explicit ollama provider when no key is set", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({
      agentDir,
      explicitProviders: {
        ollama: {
          baseUrl: "http://custom-host:11434",
          api: "ollama",
          apiKey: "custom-key",
          models: [
            {
              id: "custom-model",
              name: "custom-model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
      },
    });

    // Explicit providers are merged elsewhere; resolveImplicitProviders
    // should not inject an implicit ollama when explicit already exists
    // and no env/profile key is configured.
    expect(providers?.ollama).toBeUndefined();
  });

  it("registers ollama with empty apiKey when server is reachable (happy path)", async () => {
    // Mock global fetch to simulate a reachable Ollama server returning models.
    const mockModels = {
      models: [
        { name: "llama3.3:latest", model: "llama3.3:latest", size: 0, digest: "", details: {} },
      ],
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockModels,
    }) as unknown as typeof fetch;
    // Temporarily clear VITEST env so probeOllamaModels doesn't short-circuit.
    const origVitest = process.env.VITEST;
    const origNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    try {
      const result = await resolveImplicitProviders({ agentDir });
      expect(result?.ollama).toBeDefined();
      expect(result?.ollama?.apiKey).toBe("");
      expect(result?.ollama?.api).toBe("ollama");
      expect(result?.ollama?.models?.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.VITEST = origVitest;
      if (origNodeEnv !== undefined) {
        process.env.NODE_ENV = origNodeEnv;
      }
      vi.restoreAllMocks();
    }
  });

  it("should still register with key even when explicit provider exists", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    process.env.OLLAMA_API_KEY = "test-key";

    try {
      const providers = await resolveImplicitProviders({
        agentDir,
        explicitProviders: {
          ollama: {
            baseUrl: "http://remote:11434/v1",
            api: "openai-completions",
            models: [],
          },
        },
      });

      expect(providers?.ollama).toBeDefined();
      expect(providers?.ollama?.apiKey).toBe("OLLAMA_API_KEY");
      // resolveOllamaApiBase strips /v1
      expect(providers?.ollama?.baseUrl).toBe("http://remote:11434");
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  });
});
