export function containsUrlIdentity(output: string, url: string): boolean {
  return [url, encodedLinkIdentity(url)].some((candidate) => containsBoundedIdentity(output, candidate));
}

export function visibleDiscordText(value: string): string {
  let fence = 0;
  return value.split("\n").map((line) => {
    const marker = line.match(/^(`{3,})/);
    if (!fence && marker) { fence = marker[1].length; return line; }
    if (fence && marker && marker[1].length >= fence && line.slice(marker[1].length).trim() === "") { fence = 0; return line; }
    return fence ? line : line.replaceAll(/\\([\\*_~`#>|+\-.()[\]])/g, "$1");
  }).join("\n");
}

export function normalizedWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

export function orderedContains(output: string, values: string[]): boolean {
  let offset = 0;
  for (const value of values) {
    const found = output.indexOf(value, offset);
    if (found < 0) return false;
    offset = found + value.length;
  }
  return true;
}

function containsBoundedIdentity(output: string, value: string): boolean {
  const continuation = /[A-Za-z0-9._~:/?#@!$&'*+,;=%-]/;
  let offset = 0;
  while (offset <= output.length - value.length) {
    const index = output.indexOf(value, offset);
    if (index < 0) return false;
    const before = output[index - 1] ?? "";
    const after = output[index + value.length] ?? "";
    if ((!before || !continuation.test(before)) && (!after || !continuation.test(after))) return true;
    offset = index + 1;
  }
  return false;
}

function encodedLinkIdentity(url: string): string {
  return url.replaceAll(" ", "%20").replaceAll("\\", "%5C").replaceAll("(", "%28").replaceAll(")", "%29").replaceAll("[", "%5B").replaceAll("]", "%5D").replaceAll("`", "%60");
}
