import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeDiagnostic } from "./knowledge-document.js";
import { appendEvent, type ProjectionResult, rebuildMetadata } from "./metadata.js";
import { ensureVaultStructure, fmtDate, type VaultPaths, writeJson } from "./utils.js";
import { inspectWritableVault, readVaultConfig } from "./vault-format.js";

export const WIKI_SCHEMA = [
  "# LLM Wiki 结构说明",
  "",
  "## 所有权规则",
  "",
  "| 路径 | 所有者 | 规则 |",
  "|------|--------|------|",
  "| raw/** | 扩展 | 捕获后不可变 |",
  "| wiki/** | 模型 + 用户 | 可编辑的知识页 |",
  "| meta/events.jsonl | 扩展工具 | 仅追加的权威状态 |",
  "| meta/* 除 events.jsonl | 扩展 | 生成的投影 |",
  "| . | 人 + 显式请求 | 运行规则 |",
  "",
  "备份 `meta/events.jsonl` 以保留活动历史。生成的日志无法重建它。",
  "",
  "## 源数据包格式",
  "",
  "```",
  "raw/sources/SRC-YYYY-MM-DD-NNN/",
  "  manifest.json",
  "  original/",
  "  extracted.md",
  "  attachments/",
  "```",
  "",
  "## 页面类型",
  "",
  "- **source** — 该具体来源说了什么",
  "- **entity** — 人物、组织、工具、产品",
  "- **concept** — 想法、模式、框架",
  "- **synthesis** — 跨来源论题与张力",
  "- **analysis** — 查询得到的持久化答案",
  "- **requirement** — 带状态、优先级与可追溯性的原子需求",
  "",
  "## 链接风格",
  "",
  "- 新内部链接: [标签](/folder/page.md)",
  "- 旧版可读链接: [[folder/page]]",
  "- 来源引用: [来源](/sources/SRC-YYYY-MM-DD-NNN.md)",
  "",
  "## 中文约定（本 fork）",
  "",
  "- 页面 `title`、正文标题与**文件名**使用中文（经 slugify）。",
  "- 目录名、工具名、命令名与路径片段保持英文（如 `wiki/concepts/`、`wiki_recall`）。",
  "- 代码、API、文件路径、命令与专有技术标识保持原样。",
  "",
].join("\n");

export interface BootstrapInput {
  topic: string;
  mode: string;
}

export type BootstrapResult =
  | { ok: true; created: boolean; projection: ProjectionResult }
  | { ok: false; created: false; diagnostics: KnowledgeDiagnostic[] };

export function bootstrapVault(paths: VaultPaths, input: BootstrapInput): BootstrapResult {
  const configPath = join(paths.dotWiki, "config.json");
  const created = !existsSync(paths.dotWiki);
  let existing: Record<string, unknown> = {};

  if (!created) {
    const writable = inspectWritableVault(paths);
    if (!writable.ok) return { ok: false, created: false, diagnostics: writable.diagnostics };
    const config = readVaultConfig(paths);
    if (!config.ok) return { ok: false, created: false, diagnostics: [config.diagnostic] };
    existing = config.config;
  }

  const config: Record<string, unknown> = {
    ...existing,
    name: input.topic,
    mode: input.mode,
    topic: input.topic,
    created: existing.created ?? fmtDate(),
    version: existing.version ?? "1.0",
    vault_id: existing.vault_id ?? randomUUID(),
    ...(created ? { knowledge_format: "okf-0.2" } : {}),
  };

  ensureVaultStructure(paths);
  writeJson(configPath, config);
  writeFileSync(join(paths.dotWiki, "WIKI_SCHEMA.md"), WIKI_SCHEMA, "utf8");
  appendEvent(paths, { kind: "bootstrap", topic: input.topic, mode: input.mode });
  return { ok: true, created, projection: rebuildMetadata(paths) };
}
