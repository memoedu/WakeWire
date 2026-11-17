import { z } from "zod";

const text = z
  .string()
  .max(12000)
  .refine(
    (s) => !/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s),
  );
const marked = z
  .object({
    i: z.literal("m"),
    text,
    b: z.boolean().optional(),
    l: z.boolean().optional(),
    u: z.boolean().optional(),
    q: z.boolean().optional(),
    url: z.string().optional(),
    iUrl: z.string().optional(),
  })
  .strict();
const math = z
  .object({ i: z.literal("x"), text: text.max(4000), block: z.boolean().optional() })
  .strict();
const reference = z.object({ i: z.literal("q"), _id: z.string().min(1).max(128) }).strict();

/** Read-only support for a known native mark while older rich-text bridges reject it. */
export function underlineSnapshotContent(
  native: unknown[],
  refs: Array<{ targetRemId: string; text: string }>,
): Array<Record<string, unknown>> {
  if (
    native.length > 1000 ||
    !native.some((p) => p && typeof p === "object" && "u" in p && p.u === true)
  )
    throw Error("native underline snapshot is unavailable");
  let size = 0;
  const result = native.map((part): Record<string, unknown> => {
    if (typeof part === "string") {
      size += text.parse(part).length;
      return { text: part };
    }
    const run = marked.safeParse(part);
    if (run.success) {
      const p = run.data;
      size += p.text.length;
      const content = {
        text: p.text,
        ...(p.b ? { bold: true } : {}),
        ...(p.l ? { italic: true } : {}),
        ...(p.u ? { underline: true } : {}),
        ...(p.q ? { code: true } : {}),
      };
      const url = p.iUrl ?? p.url;
      if (!url) return content;
      const parsed = new URL(url);
      if (
        !/^(https?:|mailto:)/u.test(url) ||
        parsed.username ||
        parsed.password ||
        [...url].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === "\\") ||
        (p.iUrl && p.url && p.iUrl !== p.url)
      )
        throw Error("native underline link is unsupported");
      return { type: "link", url, children: [content] };
    }
    const equation = math.safeParse(part);
    if (equation.success) {
      size += equation.data.text.length;
      return { type: "math", tex: equation.data.text, display: equation.data.block ?? false };
    }
    const ref = reference.safeParse(part);
    if (ref.success) {
      const matches = refs.filter((r) => r.targetRemId === ref.data._id);
      if (matches.length !== 1 || !matches[0]?.text || /\[\[|\]\]|\n/u.test(matches[0].text))
        throw Error("native underline reference is unresolved");
      size += matches[0].text.length + 4;
      return { text: `[[${matches[0].text}]]` };
    }
    throw Error("native underline contains an unsupported rich-text element");
  });
  if (size > 12000) throw Error("native underline content exceeds supported size");
  return result;
}
