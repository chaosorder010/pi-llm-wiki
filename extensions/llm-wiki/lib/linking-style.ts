/**
 * Engineering linking-style conventions (short-title Markdown links,
 * type-dir indexes, outbound-link budget). Used by docs and soft lint.
 */

export const OUTBOUND_WIKI_LINK_LIMIT = 15;

/** Top-level wiki type directories (English path segments). */
export const WIKI_TYPE_DIRS = [
  "sources",
  "entities",
  "concepts",
  "syntheses",
  "analyses",
  "requirements",
  "skills",
  "cases",
  "specs",
  "arch",
  "tests",
  "plans",
  "trajectories",
] as const;

const TYPE_DIR_PREFIX = new RegExp(
  `^(?:${WIKI_TYPE_DIRS.join("|")})(?:/|$)`,
  "i",
);

/**
 * True when a Markdown link's visible label looks like a path or typed page id
 * rather than a short leaf title.
 */
export function isPathLikeLinkLabel(label: string): boolean {
  const text = label.trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text) || text.startsWith("mailto:")) return false;
  if (text.includes("/")) return true;
  if (TYPE_DIR_PREFIX.test(text)) return true;
  return false;
}

/** Collect visible labels of non-autolink Markdown links in a body. */
export function extractMarkdownLinkLabels(body: string): string[] {
  const labels: string[] = [];
  // Skip images ![alt](url); capture [label](url) where label has no unescaped ]
  for (const match of body.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const label = match[1] ?? "";
    const url = match[2] ?? "";
    // External http(s) labels are out of scope for wiki short-title rules
    if (/^https?:\/\//i.test(url) || url.startsWith("mailto:")) continue;
    labels.push(label);
  }
  return labels;
}
