import { describe, expect, it } from "vitest";
import { ArticleRemNoteMcp } from "./remnote-zhihu-cli.js";
import { underlineSnapshotContent } from "./remnote-zhihu-native.js";

describe("native underline reads", () => {
  it("preserves partial underline with other marks, links, equations and references", () => {
    expect(
      underlineSnapshotContent(
        [
          "Ordinary ",
          { i: "m", text: "marked", u: true, b: true, l: true },
          { i: "m", text: "link", u: true, iUrl: "https://example.org/source" },
          { i: "x", text: "x_1^2", block: false },
          { i: "q", _id: "ref" },
        ],
        [{ targetRemId: "ref", text: "Reference" }],
      ),
    ).toEqual([
      { text: "Ordinary " },
      { text: "marked", underline: true, bold: true, italic: true },
      {
        type: "link",
        url: "https://example.org/source",
        children: [{ text: "link", underline: true }],
      },
      { type: "math", tex: "x_1^2", display: false },
      { text: "[[Reference]]" },
    ]);
  });
  it("does not broaden native support or discard unrecognized marks", () => {
    for (const extra of [{ h: "red" }, { u: "yes" }, { unknown: true }])
      expect(() =>
        underlineSnapshotContent(
          [
            { i: "m", text: "known", u: true },
            { i: "m", text: "other", ...extra },
          ],
          [],
        ),
      ).toThrow();
    expect(() => underlineSnapshotContent([{ i: "m", text: "plain" }], [])).toThrow();
    expect(() =>
      underlineSnapshotContent([{ i: "m", text: "link", u: true, url: "javascript:alert(1)" }], []),
    ).toThrow();
    expect(() =>
      underlineSnapshotContent(
        [
          { i: "m", text: "known", u: true },
          { i: "q", _id: "missing" },
        ],
        [],
      ),
    ).toThrow();
  });
  class Reader extends ArticleRemNoteMcp {
    calls: string[] = [];
    native: unknown[] = ["Ordinary ", { i: "m", text: "underlined", u: true }];
    identity = "node";
    primary: unknown;
    protected override async call(name: string): Promise<unknown> {
      this.calls.push(name);
      if (name === "personalwebsite_richtext") {
        if (this.primary) return this.primary;
        throw Error("Unsupported rich-text field");
      }
      return {
        complete: true,
        nodes: [{ remId: this.identity, nativeSnapshot: { text: this.native } }],
      };
    }
  }
  it("reuses the existing snapshot API when the older bridge rejects underline", async () => {
    const r = new Reader();
    expect(await r.richText("node")).toEqual([
      { text: "Ordinary " },
      { text: "underlined", underline: true },
    ]);
    expect(r.calls).toEqual(["personalwebsite_richtext", "personalwebsite_nodes"]);
  });
  it("retains the normal read path and refuses an unrelated failure or wrong identity", async () => {
    const r = new Reader();
    r.primary = { remId: "node", content: [{ text: "normal" }] };
    expect(await r.richText("node")).toEqual([{ text: "normal" }]);
    expect(r.calls).toEqual(["personalwebsite_richtext"]);
    r.primary = undefined;
    r.native = [{ i: "m", text: "plain" }];
    await expect(r.richText("node")).rejects.toThrow("Unsupported rich-text field");
    r.identity = "wrong";
    await expect(r.richText("node")).rejects.toThrow("identity changed");
  });
});
