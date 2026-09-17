import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKnowledgeDocument, serializeKnowledgeDocument } from "./knowledge-document.js";
import { buildResolvedBacklinks, buildWikilinkIndex } from "./knowledge-links.js";
import { repairLegacyKnowledgeDocuments } from "./legacy-repair.js";
import {
  extractMarkdownLinkLabels,
  isPathLikeLinkLabel,
  OUTBOUND_WIKI_LINK_LIMIT,
} from "./linking-style.js";
import { appendEvent, rebuildMetadata, rebuildMetadataLight } from "./metadata.js";
import { readQmdIndexStatus } from "./qmd-indexing.js";
import { fmtDate, slugify, type VaultPaths, writeJson } from "./utils.js";
import {
  assertWritableVault,
  compareCodePoint,
  discoverKnowledgeDocuments,
  inspectVaultFormat,
} from "./vault-format.js";

/**
 * Wiki health scan. Extracted verbatim from tools.ts (issue #77) so the Pi tool
 * and the MCP server run the exact same lint implementation (Phase 1 of #221).
 */
export async function runWikiLint(paths: VaultPaths, autoFix: boolean): Promise<string> {
  assertWritableVault(paths);
  const qmdStatus = await readQmdIndexStatus(paths);
  let repair: ReturnType<typeof repairLegacyKnowledgeDocuments> | undefined;
  if (autoFix) {
    let projection = rebuildMetadata(paths);
    repair = !projection.ok ? repairLegacyKnowledgeDocuments(paths) : undefined;
    if (repair?.repaired) projection = rebuildMetadata(paths);
    if (!projection.ok) {
      return [
        "# Wiki Lint 报告",
        "",
        repair?.repaired ? `已修复遗留页面: ${repair.repaired}` : "",
        repair?.manifestPath ? `修复清单: ${repair.manifestPath}` : "",
        "投影阻塞诊断:",
        ...projection.diagnostics.map(
          (diagnostic) => `- ${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`,
        ),
      ]
        .filter(Boolean)
        .join("\n");
    }
  } else {
    const vault = inspectVaultFormat(paths);
    const audit = discoverKnowledgeDocuments(paths);
    const diagnostics = [...vault.diagnostics, ...audit.diagnostics];
    if (vault.blocking || audit.blocking) {
      return [
        "# Wiki Lint 报告",
        "",
        "投影阻塞诊断:",
        ...diagnostics.map(
          (diagnostic) => `- ${diagnostic.code}: ${diagnostic.path}: ${diagnostic.message}`,
        ),
      ].join("\n");
    }
  }

  const discovery = discoverKnowledgeDocuments(paths);
  const pages = discovery.documents;
  const wikilinkIndex = buildWikilinkIndex(pages.map((page) => page.id));
  const inbound = Object.fromEntries(pages.map((page) => [page.id, 0]));
  const gapSources = new Map<string, Set<string>>();
  const findings: string[] = [];
  let missingPages = 0;
  let contradictions = 0;
  let outboundOverLimit = 0;
  let pathLikeLabels = 0;

  for (const page of pages) {
    const resolved = buildResolvedBacklinks(page.id, page.body, wikilinkIndex);
    for (const target of resolved.targets) inbound[target]++;
    for (const unresolved of resolved.unresolved) {
      const sources = gapSources.get(unresolved.target) ?? new Set<string>();
      sources.add(page.id);
      gapSources.set(unresolved.target, sources);
      missingPages++;
      findings.push(`缺失页面: ${unresolved.target}（见于 ${page.id}）`);
    }
    for (const d of resolved.diagnostics) {
      if (d.code === "link_ambiguous") {
        findings.push(d.message.replace("Ambiguous wikilink: ", "歧义链接: "));
      }
    }

    // Soft style checks: outbound budget + short-title visible labels
    const outboundCount = resolved.targets.length;
    if (outboundCount > OUTBOUND_WIKI_LINK_LIMIT) {
      outboundOverLimit++;
      findings.push(
        `出链过多: ${page.id} 有 ${outboundCount} 条正向 wiki 出链（阈值 ${OUTBOUND_WIKI_LINK_LIMIT}）；请拆分为总览 + 同名文件夹子页`,
      );
    }
    for (const label of extractMarkdownLinkLabels(page.body)) {
      if (!isPathLikeLinkLabel(label)) continue;
      pathLikeLabels++;
      findings.push(
        `链接可见文案像路径: ${page.id} 使用了「${label}」；请改为叶名短标题（与 title/H1 一致）`,
      );
    }
  }

  let orphans = 0;
  for (const page of pages) {
    if (inbound[page.id] === 0) {
      orphans++;
      findings.push(`孤立页: ${page.id} 没有入链`);
    }
    if (page.body.includes("⚠️ **Contradiction") || page.body.includes("⚠️ **矛盾")) {
      contradictions++;
      findings.push(`矛盾标记见于 ${page.id}`);
    }
  }

  const gaps = [...gapSources.entries()]
    .map(([topic, sources]) => ({ topic, mentionedBy: [...sources].sort(compareCodePoint) }))
    .sort((left, right) => compareCodePoint(left.topic, right.topic));
  let fixesApplied = 0;
  if (autoFix) {
    for (const gap of gaps) {
      if (gap.mentionedBy.length < 2) continue;
      const parts = gap.topic.split("/");
      const name =
        parts.length === 1
          ? parts[0]
          : parts.length === 2 && parts[0] === "concepts"
            ? parts[1]
            : "";
      if (!name || slugify(name) !== name) continue;
      const pagePath = join(paths.wiki, "concepts", `${name}.md`);
      mkdirSync(join(paths.wiki, "concepts"), { recursive: true });
      const document = createKnowledgeDocument(
        `concepts/${name}.md`,
        {
          type: "concept",
          title: name.replace(/-/g, " "),
          created: fmtDate(),
          updated: fmtDate(),
          status: "stub",
        },
        `_存根由 lint 自动创建。请根据以下来源扩展内容: ${gap.mentionedBy
          .map((source) => `[${source}](/${source}.md)`)
          .join(", ")}_`,
      );
      try {
        writeFileSync(pagePath, serializeKnowledgeDocument(document), {
          encoding: "utf8",
          flag: "wx",
        });
        fixesApplied++;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  const reportLines = [
    "# Wiki Lint 报告",
    `生成于: ${fmtDate()}`,
    "",
    "## 摘要",
    `- 页面总数: ${pages.length}`,
    `- 孤立页: ${orphans}`,
    `- 缺失页面: ${missingPages}`,
    `- 矛盾: ${contradictions}`,
    `- 出链超限页: ${outboundOverLimit}`,
    `- 路径型链接文案: ${pathLikeLabels}`,
    autoFix ? `- 已应用缺失页修复: ${fixesApplied}` : "",
    repair?.repaired ? `- 已修复遗留页面: ${repair.repaired}` : "",
    repair?.manifestPath ? `- 修复清单: ${repair.manifestPath}` : "",
    "",
    "## 发现问题",
    findings.length ? findings.map((finding) => `- ${finding}`).join("\n") : "✅ 未发现问题！",
    "",
  ].filter(Boolean);
  const reportPath = autoFix ? join(paths.outputs, `lint-${fmtDate()}.md`) : undefined;
  // The gap snapshot is generated discovery metadata consumed by wiki_status:
  // persist it on every successful lint so status never reports a stale count.
  // Corrective actions below (report, event, meta rebuild) stay autoFix-only.
  // mkdir mirrors the autoFix report write below: on a fresh checkout the
  // gitignored .discoveries dir does not exist yet (issue #203).
  mkdirSync(paths.discoveries, { recursive: true });
  writeJson(join(paths.discoveries, "gaps.json"), {
    gaps,
    generated: new Date().toISOString(),
  });
  if (autoFix && reportPath) {
    mkdirSync(paths.outputs, { recursive: true });
    writeFileSync(reportPath, `${reportLines.join("\n")}\n`, "utf8");
    appendEvent(paths, {
      kind: "lint",
      orphans,
      missing_pages: missingPages,
      contradictions,
      auto_fix: true,
      legacy_pages_repaired: repair?.repaired ?? 0,
    });
    rebuildMetadataLight(paths);
  }

  const qmdFindings: string[] = [];
  if (qmdStatus.state === "stale") {
    const components = JSON.stringify(
      qmdStatus.repairComponents.length > 0 ? qmdStatus.repairComponents : ["lexical"],
    );
    qmdFindings.push(
      `- QMD index stale (${qmdStatus.indexedManifestHash ? "manifest or model changed" : ""}): repair with \`wiki_reindex(scope="changed", components=${components}, vault="active")\``,
    );
  } else if (qmdStatus.state === "recovering") {
    qmdFindings.push(
      `- QMD swap interrupted (${qmdStatus.swapPhase ?? ""}): restart recovery via \`wiki_reindex(vault="active")\``,
    );
  } else if (qmdStatus.state === "error") {
    qmdFindings.push(
      `- QMD index error: ${qmdStatus.issues[0]?.message ?? "repair with wiki_reindex"} — \`wiki_reindex(scope="changed", components=${JSON.stringify(qmdStatus.repairComponents.length > 0 ? qmdStatus.repairComponents : ["lexical"])}, vault="active")\``,
    );
  } else if (qmdStatus.state === "missing") {
    qmdFindings.push("- QMD index not built yet (informational): run wiki_reindex to build it");
  }

  return [
    "🧹 **LLM Wiki lint complete**",
    "",
    `- Pages: ${pages.length}`,
    `- Orphans: ${orphans}`,
    `- Missing: ${missingPages}`,
    `- Contradictions: ${contradictions}`,
    `- Outbound over limit: ${outboundOverLimit}`,
    `- Path-like link labels: ${pathLikeLabels}`,
    autoFix ? `- Missing-page fixes: ${fixesApplied}` : "",
    repair?.repaired ? `- Legacy pages repaired: ${repair.repaired}` : "",
    "",
    reportPath ? `📄 Report: \`${reportPath}\`` : "",
    repair?.manifestPath ? `🛟 Repair manifest: \`${repair.manifestPath}\`` : "",
    gaps.length ? `💡 ${gaps.length} knowledge gap(s) tracked` : "",
    "",
    "## QMD Index",
    `- State: ${qmdStatus.state}`,
    ...qmdFindings,
    ...(() => {
      const style = findings.filter(
        (f) => f.startsWith("出链过多") || f.startsWith("链接可见文案像路径"),
      );
      if (style.length === 0) return [];
      return ["", "## Linking style", ...style.map((f) => `- ${f}`)];
    })(),
  ]
    .filter(Boolean)
    .join("\n");
}
