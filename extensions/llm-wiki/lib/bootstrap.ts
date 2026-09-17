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
  "- 默认用带短标题的 Markdown 链接：`[短标题](/folder/page.md)`。",
  "- 遗留可读链接：`[[folder/page]]`；新写页面不要用它当正文可见文案，图渲染会把整段路径当标签。",
  "- 来源引用：`[SRC-YYYY-MM-DD-NNN](/sources/SRC-YYYY-MM-DD-NNN.md)`。",
  "",
  "### 短标题",
  "",
  "- 正文可见文案只用页面短标题，不显示类型前缀、目录前缀或完整 page id。",
  "- 禁止可见文案写成 `syntheses/...`、`tests/...`、`requirements/...` 等路径，或 `需求索引-`、`验收-` 这类与目录/角色重复的前缀。",
  "- `title` / H1 与可见链接文案一致，取叶名短标题（如 `看板`），路径本身保留层级信息。",
  "- 链接写成 `[看板](/syntheses/知识库管理平台需求分解索引/看板.md)`，不写成 `[[syntheses/知识库管理平台需求分解索引/看板]]`。",
  "",
  "### 类型目录 index",
  "",
  "- `wiki/<type-dir>/index.md` **只索引根入口**（总览页），不罗列文件夹内的子页。",
  "- 子页由总览页或 `wiki/<type-dir>/<总览短标题>/index.md` 索引。",
  "",
  "### 图出链分页（阈值 15）",
  "",
  "- 任一页面的**正向出链**（指向其他 wiki 页的链接）超过 **15** 时，必须拆分，禁止继续堆在同一页。",
  "- 拆分方式：总览页只保留入口；明细子页放进与总览同名的文件夹。",
  "",
  "```",
  "wiki/<type-dir>/<总览短标题>.md",
  "wiki/<type-dir>/<总览短标题>/",
  "  index.md",
  "  <域短标题>.md",
  "```",
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
