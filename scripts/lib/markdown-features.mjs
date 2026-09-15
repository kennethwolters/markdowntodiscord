export const markdownFeaturePatterns = {
  fenced_code: /(^|\n)\s*(`{3,}|~{3,})/m,
  inline_code: /(^|[^`])`[^`\n]+`/,
  gfm_table_candidate: /(^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/m,
  task_list: /(^|\n)\s*[-+*]\s+\[[ xX]\]\s/m,
  markdown_image: /!\[[^\]]*\]\([^\n)]+\)/,
  inline_link: /(^|[^!])\[[^\]]+\]\([^\n)]+\)/,
  reference_link: /\[[^\]]+\]\[[^\]]*\]/,
  footnote: /\[\^[^\]]+\]/,
  heading: /(^|\n)\s{0,3}#{1,6}\s+\S/m,
  deep_heading: /(^|\n)\s{0,3}#{4,6}\s+\S/m,
  blockquote: /(^|\n)\s{0,3}>\s?/m,
  html: /<\/?[a-zA-Z][^>]*>/,
  details_html: /<details\b/i,
  mermaid: /(^|\n)\s*`{3,}mermaid\b/im,
  latex: /\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/,
  discord_mention: /@(everyone|here)\b|<@[!&]?\d+>/i,
  spoiler: /\|\|[^\n|]+\|\|/,
  horizontal_rule: /(^|\n)\s{0,3}([-*_])(?:\s*\2){2,}\s*($|\n)/m,
  ordered_list: /(^|\n)\s{0,3}\d+[.)]\s+\S/m,
  unordered_list: /(^|\n)\s{0,3}[-+*]\s+\S/m
};

export function detectMarkdownFeatures(text) {
  const features = Object.entries(markdownFeaturePatterns)
    .filter(([, pattern]) => pattern.test(text))
    .map(([feature]) => feature);
  if (unbalancedFenceCandidate(text)) features.push("unbalanced_fence_candidate");
  return features;
}

export function unbalancedFenceCandidate(text) {
  let open;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const marker = match[1][0];
    const length = match[1].length;
    if (!open) open = { marker, length };
    else if (marker === open.marker && length >= open.length) open = undefined;
  }
  return Boolean(open);
}
