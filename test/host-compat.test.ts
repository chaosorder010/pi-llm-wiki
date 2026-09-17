import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectHost,
  listGlobalSettingsFiles,
  listProjectSettingsFiles,
  resolveProjectSettingsPath,
} from "../extensions/llm-wiki/lib/host.js";
import {
  loadTaskConfig,
  persistTaskModel,
  persistTrajectoriesEnabled,
  trajectoriesEnabled,
} from "../extensions/llm-wiki/lib/task-config.js";

/**
 * Dual-host compatibility: the extension must behave identically under pi
 * (`.pi`, `~/.pi/agent`) and oh-my-pi (`.omp`, `~/.omp/agent`). oh-my-pi never
 * reads `.pi`, so settings written under one host must remain readable when the
 * other takes over the same repository.
 */

let tmpDir: string;
let priorAgentDir: string | undefined;
let priorHost: string | undefined;
let priorProfile: string | undefined;

beforeEach(() => {
  tmpDir = join(tmpdir(), `llm-wiki-host-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  priorHost = process.env.LLM_WIKI_HOST;
  priorProfile = process.env.OMP_PROFILE;
  // Hermetic: point the user-level layer at an empty directory so a developer's
  // real ~/.pi or ~/.omp settings cannot leak into these assertions.
  process.env.PI_CODING_AGENT_DIR = join(tmpDir, "agent-home");
  for (const key of ["LLM_WIKI_HOST", "OMP_PROFILE"] as const) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of [
    ["PI_CODING_AGENT_DIR", priorAgentDir],
    ["LLM_WIKI_HOST", priorHost],
    ["OMP_PROFILE", priorProfile],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSettings(dir: string, name: string, body: string): void {
  mkdirSync(join(tmpDir, dir), { recursive: true });
  writeFileSync(join(tmpDir, dir, name), body, "utf-8");
}

describe("detectHost", () => {
  it("honours an explicit LLM_WIKI_HOST override", () => {
    process.env.LLM_WIKI_HOST = "omp";
    expect(detectHost()).toBe("omp");
    process.env.LLM_WIKI_HOST = " PI ";
    expect(detectHost()).toBe("pi");
  });

  it("classifies by the agent directory marker segment", () => {
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, ".omp", "agent");
    expect(detectHost()).toBe("omp");
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, ".pi", "agent");
    expect(detectHost()).toBe("pi");
  });

  it("falls back to OMP_PROFILE, then to pi", () => {
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, "neutral");
    expect(detectHost()).toBe("pi");
    process.env.OMP_PROFILE = "work";
    expect(detectHost()).toBe("omp");
  });

  it("ignores an unrecognised LLM_WIKI_HOST value", () => {
    process.env.LLM_WIKI_HOST = "claude";
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, "neutral");
    expect(detectHost()).toBe("pi");
  });
});

describe("settings file discovery", () => {
  it("lists both config directories with the active host last", () => {
    const underOmp = listProjectSettingsFiles(tmpDir, "omp");
    expect(underOmp[0]).toBe(join(tmpDir, ".pi", "settings.json"));
    expect(underOmp.at(-1)).toBe(join(tmpDir, ".omp", "config.yaml"));

    const underPi = listProjectSettingsFiles(tmpDir, "pi");
    expect(underPi[0]).toBe(join(tmpDir, ".omp", "settings.json"));
    expect(underPi.at(-1)).toBe(join(tmpDir, ".pi", "config.yaml"));

    // Same set either way — only the precedence order flips.
    expect([...underOmp].sort()).toEqual([...underPi].sort());
  });

  it("resolves user-level files under the host's agent directory", () => {
    const agentHome = join(tmpDir, "agent-home");
    expect(listGlobalSettingsFiles()).toEqual([
      join(agentHome, "settings.json"),
      join(agentHome, "config.yml"),
      join(agentHome, "config.yaml"),
    ]);
  });

  it("writes into whichever config directory already exists", () => {
    // Neither exists: the detected host's native directory is chosen.
    expect(resolveProjectSettingsPath(tmpDir, "omp")).toBe(join(tmpDir, ".omp", "settings.json"));

    // A pi-configured repo keeps a single settings file even under oh-my-pi.
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    expect(resolveProjectSettingsPath(tmpDir, "omp")).toBe(join(tmpDir, ".pi", "settings.json"));

    // Once the native directory exists it wins again.
    mkdirSync(join(tmpDir, ".omp"), { recursive: true });
    expect(resolveProjectSettingsPath(tmpDir, "omp")).toBe(join(tmpDir, ".omp", "settings.json"));
  });
});

describe("loadTaskConfig across hosts", () => {
  it("reads the llm-wiki section from .omp/settings.json", () => {
    writeSettings(".omp", "settings.json", JSON.stringify({ "llm-wiki": { trajectories: true } }));
    expect(trajectoriesEnabled(loadTaskConfig(tmpDir))).toBe(true);
  });

  it("reads the llm-wiki section from .omp/config.yml", () => {
    writeSettings(".omp", "config.yml", 'llm-wiki:\n  synthesisLanguage: "ru"\n  notices: false\n');
    const cfg = loadTaskConfig(tmpDir);
    expect(cfg.synthesisLanguage).toBe("ru");
    expect(cfg.notices).toBe(false);
  });

  it("keeps reading a pi-configured repo after oh-my-pi takes over", () => {
    process.env.LLM_WIKI_HOST = "omp";
    writeSettings(
      ".pi",
      "settings.json",
      JSON.stringify({ "llm-wiki": { taskModel: { provider: "anthropic", id: "claude-haiku" } } }),
    );
    expect(loadTaskConfig(tmpDir).taskModel).toEqual({
      provider: "anthropic",
      id: "claude-haiku",
    });
  });

  it("lets the active host's directory win over the foreign one", () => {
    process.env.LLM_WIKI_HOST = "omp";
    writeSettings(".pi", "settings.json", JSON.stringify({ "llm-wiki": { semanticWeight: 0.2 } }));
    writeSettings(".omp", "settings.json", JSON.stringify({ "llm-wiki": { semanticWeight: 0.9 } }));
    expect(loadTaskConfig(tmpDir).semanticWeight).toBe(0.9);

    process.env.LLM_WIKI_HOST = "pi";
    expect(loadTaskConfig(tmpDir).semanticWeight).toBe(0.2);
  });

  it("ignores a corrupt YAML settings file without throwing", () => {
    writeSettings(".omp", "config.yml", "llm-wiki:\n  - [unbalanced\n");
    expect(() => loadTaskConfig(tmpDir)).not.toThrow();
    expect(loadTaskConfig(tmpDir).synthesisLanguage).toBe("zh");
  });
});

describe("persistence across hosts", () => {
  it("writes to .omp/settings.json under oh-my-pi and reads it back", () => {
    process.env.LLM_WIKI_HOST = "omp";
    persistTaskModel(tmpDir, { provider: "openai", id: "gpt-4o" });
    const raw = JSON.parse(readFileSync(join(tmpDir, ".omp", "settings.json"), "utf-8"));
    expect(raw["llm-wiki"].taskModel).toEqual({ provider: "openai", id: "gpt-4o" });
    expect(loadTaskConfig(tmpDir).taskModel).toEqual({ provider: "openai", id: "gpt-4o" });
  });

  it("updates the existing .pi file instead of forking a second one", () => {
    process.env.LLM_WIKI_HOST = "omp";
    writeSettings(".pi", "settings.json", JSON.stringify({ theme: "dark" }));
    persistTrajectoriesEnabled(tmpDir, true);

    const raw = JSON.parse(readFileSync(join(tmpDir, ".pi", "settings.json"), "utf-8"));
    expect(raw.theme).toBe("dark");
    expect(raw["llm-wiki"].trajectories).toBe(true);
    expect(trajectoriesEnabled(loadTaskConfig(tmpDir))).toBe(true);
  });

  it("never rewrites a hand-authored config.yml", () => {
    process.env.LLM_WIKI_HOST = "omp";
    const yaml = "# hand written\nllm-wiki:\n  notices: false\n";
    writeSettings(".omp", "config.yml", yaml);
    persistTaskModel(tmpDir, { provider: "openai", id: "gpt-4o" });

    expect(readFileSync(join(tmpDir, ".omp", "config.yml"), "utf-8")).toBe(yaml);
    const json = JSON.parse(readFileSync(join(tmpDir, ".omp", "settings.json"), "utf-8"));
    expect(json["llm-wiki"].taskModel).toEqual({ provider: "openai", id: "gpt-4o" });
    // config.yml still outranks settings.json inside the same directory.
    expect(loadTaskConfig(tmpDir).notices).toBe(false);
  });
});
