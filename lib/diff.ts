// Small word-level diff so customer edits can be shown Google-Docs-style
// (old text struck through, new text inserted) without pulling in a diff
// library. Texts here are short outreach messages, so a plain O(n*m) LCS is
// more than fast enough.

export type DiffPart = { type: "same" | "del" | "ins"; text: string };

// Split into words while keeping the whitespace attached to the following
// word, so re-joining parts reproduces the original spacing exactly.
function tokenize(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

export function wordDiff(oldText: string, newText: string): DiffPart[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Walk the table to build the diff, merging adjacent same-type tokens.
  const parts: DiffPart[] = [];
  function push(type: DiffPart["type"], text: string) {
    const last = parts[parts.length - 1];
    if (last && last.type === type) {
      last.text += text;
    } else {
      parts.push({ type, text });
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("ins", b[j]);
      j++;
    }
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);

  return parts;
}
