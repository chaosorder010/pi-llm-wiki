import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapVault } from "../extensions/llm-wiki/lib/bootstrap.js";
import { runWikiLint } from "../extensions/llm-wiki/lib/lint.js";
import { getVaultPaths } from "../extensions/llm-wiki/lib/utils.js";

let wikiDir: string;

afterEach(() => {
  if (wikiDir) rmSync(wikiDir, { recursive: true, force: true });
});

function prep(): ReturnType<typeof getVaultPaths> {
  wikiDir = join(
    import.meta.dirname,
    "..",
    "tmp",
    `link-lint-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(wikiDir, { recursive: true });
  const paths = getVaultPaths(wikiDir);
  bootstrapVault(paths, { topic: "链接约定", mode: "personal" });
  return paths;
}

function writePage(paths: ReturnType<typeof getVaultPaths>, rel: string, body: string): void {
  const full = join(paths.wiki, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(
    full,
    `---
type: concept
title: ${rel.replace(/\.md$/, "").split("/").pop()}
created: 2026-09-17
updated: 2026-09-17
---

${body}
`,
    "utf8",
  );
}

describe("wiki_lint linking style", () => {
  it("warns when outbound wiki links exceed 15", async () => {
    const paths = prep();
    const links = Array.from({ length: 16 }, (_, i) => {
      const name = `目标${i}`;
      writePage(paths, `concepts/${name}.md`, `# ${name}\n\n内容。\n`);
      return `[${name}](/concepts/${name}.md)`;
    });
    writePage(paths, "concepts/枢纽.md", `# 枢纽\n\n${links.join("\n")}\n`);

    const report = await runWikiLint(paths, false);
    expect(report).toContain("出链过多");
    expect(report).toContain("concepts/枢纽");
    expect(report).toMatch(/Outbound over limit: [1-9]/);
  });

  it("warns when markdown link label looks like a path", async () => {
    const paths = prep();
    writePage(paths, "concepts/看板.md", "# 看板\n\n内容。\n");
    writePage(
      paths,
      "concepts/坏链.md",
      `# 坏链\n\n见 [concepts/看板](/concepts/看板.md)。\n`,
    );

    const report = await runWikiLint(paths, false);
    expect(report).toContain("链接可见文案像路径");
    expect(report).toContain("concepts/坏链");
    expect(report).toMatch(/Path-like link labels: [1-9]/);
  });

  it("WIKI_SCHEMA documents short-title and outbound-15 rules", () => {
    const paths = prep();
    const schema = readFileSync(join(paths.dotWiki, "WIKI_SCHEMA.md"), "utf8");
    expect(schema).toContain("短标题");
    expect(schema).toContain("阈值 15");
    expect(schema).toContain("类型目录 index");
  });
});
