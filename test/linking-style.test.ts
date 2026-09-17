import { describe, expect, it } from "vitest";
import {
  extractMarkdownLinkLabels,
  isPathLikeLinkLabel,
  OUTBOUND_WIKI_LINK_LIMIT,
} from "../extensions/llm-wiki/lib/linking-style.js";

describe("linking-style", () => {
  it("exports outbound limit 15", () => {
    expect(OUTBOUND_WIKI_LINK_LIMIT).toBe(15);
  });

  it("detects path-like labels", () => {
    expect(isPathLikeLinkLabel("看板")).toBe(false);
    expect(isPathLikeLinkLabel("syntheses/知识库/看板")).toBe(true);
    expect(isPathLikeLinkLabel("specs/摄入契约")).toBe(true);
    expect(isPathLikeLinkLabel("concepts")).toBe(true);
    expect(isPathLikeLinkLabel("https://example.com")).toBe(false);
  });

  it("extracts markdown labels and skips images/external", () => {
    const body = `
[看板](/syntheses/索引/看板.md)
![图](/assets/x.png)
[外链](https://example.com)
[specs/坏文案](/specs/坏文案.md)
`;
    expect(extractMarkdownLinkLabels(body)).toEqual(["看板", "specs/坏文案"]);
  });
});
