import { describe, expect, it } from "vitest";
import type { RemNode, RemNoteReader } from "./remnote-todo.js";
import {
  type ArticlePublisher,
  type ArticleReader,
  type ArticleRem,
  type ArticleState,
  adoptPublishedArticle,
  publicationSlot,
  runArticles,
  saveReviewDraft,
  scanArticles,
  seriesTitle,
  snapshotArticle,
} from "./remnote-zhihu.js";

function fixture() {
  const nodes = new Map<string, RemNode>([
    ["doc", { remId: "doc", title: "Article Source", remType: "document" }],
    ["published", { remId: "published", title: "已发布", parentRemId: "doc" }],
    ["old", { remId: "old", title: "%archived", parentRemId: "published" }],
    ["group", { remId: "group", title: "PRIVATE PARENT", parentRemId: "doc" }],
    ["one", { remId: "one", title: "%first", parentRemId: "doc" }],
    ["child", { remId: "child", title: "detail text", parentRemId: "one" }],
    ["sibling", { remId: "sibling", title: "PRIVATE SIBLING", parentRemId: "group" }],
    ["two", { remId: "two", title: "%second", parentRemId: "doc" }],
    ["child2", { remId: "child2", title: "second detail", parentRemId: "two" }],
  ]);
  const remnote: RemNoteReader = {
    async read(id) {
      const node = nodes.get(id);
      if (!node) throw new Error("not found");
      return structuredClone(node);
    },
    async children(id) {
      return {
        children: [...nodes.values()]
          .filter((n) => n.parentRemId === id)
          .map((n) => structuredClone(n)),
        hasMore: false,
      };
    },
    async create(parentRemId, title) {
      const remId = `new-${nodes.size}`;
      nodes.set(remId, { remId, parentRemId, title });
      return remId;
    },
    async updateTitle(id, title) {
      (nodes.get(id) as RemNode).title = title;
    },
    async move(id, parent, expected) {
      const node = nodes.get(id) as RemNode;
      if (node.parentRemId !== expected) throw new Error("parent mismatch");
      node.parentRemId = parent;
    },
  };
  const state: ArticleState = { receipts: [] };
  let posts = 0;
  let persisted = "";
  const publisher: ArticlePublisher = {
    async prepare(rows) {
      const text = rows
        .slice(1)
        .map((n) => n.text)
        .join("");
      return { title: rows[0]?.text ?? "", html: `<p>${text}</p>`, text, format: "[]" };
    },
    async check() {
      return { id: "account", name: "author", urlToken: "author", columnId: "col" };
    },
    async publish() {
      posts++;
      return { id: String(100 + posts) };
    },
    async verify(id) {
      return {
        id,
        authorId: "account",
        title: state.receipts.at(-1)?.title ?? "",
        text: state.receipts.at(-1)?.text ?? "",
        format: "[]",
        columnIds: ["col"],
        url: `https://zhuanlan.zhihu.com/p/${id}`,
      };
    },
  };
  const options = {
    remnote,
    publisher,
    documentRemId: "doc",
    accountId: "account",
    columnId: "col",
    state,
    save: () => {
      persisted = JSON.stringify(state);
    },
    now: new Date("2026-11-14T03:30:00Z"),
  };
  return {
    nodes,
    remnote,
    state,
    publisher,
    options,
    posts: () => posts,
    persisted: () => persisted,
  };
}

function taggedFixture() {
  const f = fixture();
  const nodes = f.nodes as Map<string, ArticleRem>;
  const remnote: ArticleReader = f.remnote;
  (nodes.get("one") as ArticleRem).title = "first";
  (nodes.get("two") as ArticleRem).title = "second";
  nodes.set("elsewhere", { remId: "elsewhere", title: "Other Document", remType: "document" });
  nodes.set("external", {
    remId: "external",
    title: "%External title",
    parentRemId: "elsewhere",
    tags: [
      { tagRemId: "doc", name: "Article Source" },
      { tagRemId: "private-tag", name: "Keep" },
    ],
  });
  nodes.set("external-body", {
    remId: "external-body",
    title: "Complete external article body",
    parentRemId: "external",
  });
  const tagCalls: Array<{ id: string; add: string[]; remove: string[] }> = [];
  remnote.tagged = async (tagRemId) => ({
    results: [...nodes.values()]
      .filter((node) => node.tags?.some((tag) => tag.tagRemId === tagRemId))
      .map((node) => structuredClone(node)),
    hasMore: false,
  });
  remnote.updateTags = async (id, add, remove) => {
    tagCalls.push({ id, add, remove });
    const node = nodes.get(id) as ArticleRem;
    node.tags = (node.tags ?? []).filter((tag) => !remove.includes(tag.tagRemId));
    for (const tagRemId of add)
      if (!node.tags.some((tag) => tag.tagRemId === tagRemId))
        node.tags.push({ tagRemId, name: tagRemId });
  };
  return {
    ...f,
    nodes,
    remnote,
    tagCalls,
    options: { ...f.options, remnote, publishedTagRemId: "published" },
  };
}

describe("RemNote to Zhihu publishing", () => {
  it("publishes external tagged content in place, switches only workflow tags and clears the marker", async () => {
    const f = taggedFixture();
    const source = await snapshotArticle(f.remnote, "external");
    const result = await runArticles(f.options);
    expect(result).toMatchObject({ published: 1, archived: 1 });
    expect(f.posts()).toBe(1);
    expect(f.nodes.get("external")).toMatchObject({
      title: "External title",
      parentRemId: "elsewhere",
    });
    expect(
      f.nodes
        .get("external")
        ?.tags?.map((tag) => tag.tagRemId)
        .sort(),
    ).toEqual(["private-tag", "published"]);
    expect((await snapshotArticle(f.remnote, "external")).fingerprint).toBe(source.fingerprint);
    expect(f.state.receipts[0]?.source.tagTrigger).toEqual({
      triggerTagRemId: "doc",
      publishedTagRemId: "published",
    });
    expect(f.tagCalls).toEqual([
      { id: "external", add: ["published"], remove: [] },
      { id: "external", add: [], remove: ["doc"] },
    ]);
  });
  it("requires both the exact source tag and a single percent marker", async () => {
    const f = taggedFixture();
    const root = f.nodes.get("external") as ArticleRem;
    root.title = "External title";
    expect((await scanArticles(f.remnote, "doc", "published")).sources).toHaveLength(0);
    root.title = "%External title";
    root.tags = [{ tagRemId: "same-name-but-other-id", name: "Article Source" }];
    expect((await scanArticles(f.remnote, "doc", "published")).sources).toHaveLength(0);
    root.tags = [
      { tagRemId: "doc", name: "Article Source" },
      { tagRemId: "published", name: "已发布" },
    ];
    expect((await scanArticles(f.remnote, "doc", "published")).sources).toHaveLength(0);
    root.tags = [{ tagRemId: "doc", name: "Article Source" }];
    root.title = "%%Paused";
    expect((await scanArticles(f.remnote, "doc", "published")).sources).toHaveLength(0);
  });
  it("ignores an unmarked query portal while still blocking a marked portal", async () => {
    const f = taggedFixture();
    f.nodes.set("query", {
      remId: "query",
      title: "query:Tagged content",
      remType: "portal",
      parentRemId: "doc",
    });
    expect((await scanArticles(f.remnote, "doc", "published")).blocked).toEqual([]);
    (f.nodes.get("query") as ArticleRem).title = "%query:Tagged content";
    expect((await scanArticles(f.remnote, "doc", "published")).blocked).toEqual(["query"]);
  });
  it("deduplicates document descendants and tag hits, retaining the original document archive mode", async () => {
    const f = taggedFixture();
    const local = f.nodes.get("one") as ArticleRem;
    local.title = "%first";
    local.tags = [{ tagRemId: "doc", name: "Article Source" }];
    const scan = await scanArticles(f.remnote, "doc", "published");
    expect(scan.sources.map((source) => source.remId)).toEqual(["one", "external"]);
    expect(scan.sources[0]?.tagTrigger).toBeUndefined();
    await runArticles(f.options);
    expect(f.nodes.get("one")?.parentRemId).toBe("published");
    expect(f.tagCalls).toHaveLength(0);
  });
  it("supports a tagged source at the knowledge-base root without moving it", async () => {
    const f = taggedFixture();
    delete (f.nodes.get("external") as ArticleRem).parentRemId;
    await runArticles(f.options);
    expect(f.nodes.get("external")?.parentRemId).toBeUndefined();
    expect(f.state.receipts[0]?.source.parentRemId).toBe("");
    expect(f.state.receipts[0]?.stage).toBe("archived");
  });
  it("rejects nested marked tag sources rather than publishing either subtree twice", async () => {
    const f = taggedFixture();
    const child = f.nodes.get("external-body") as ArticleRem;
    child.title = "%Nested title";
    child.tags = [{ tagRemId: "doc", name: "Article Source" }];
    const scan = await scanArticles(f.remnote, "doc", "published");
    expect(scan.sources).toHaveLength(0);
    expect(scan.blocked.sort()).toEqual(["external", "external-body"]);
  });
  it("rejects truncated tag search and repeated pagination cursors", async () => {
    const f = taggedFixture();
    f.remnote.tagged = async () => ({ results: [], truncated: true });
    await expect(scanArticles(f.remnote, "doc", "published")).rejects.toThrow("truncated");
    f.remnote.tagged = async () => ({ results: [], hasMore: true, nextCursor: "again" });
    await expect(scanArticles(f.remnote, "doc", "published")).rejects.toThrow("cursor");
    expect(f.posts()).toBe(0);
  });
  it("rechecks the trigger tag immediately before publication", async () => {
    const f = taggedFixture();
    f.publisher.check = async () => {
      (f.nodes.get("external") as ArticleRem).tags = [];
      return { id: "account", name: "author", urlToken: "author", columnId: "col" };
    };
    await expect(runArticles(f.options)).rejects.toThrow("trigger changed");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts).toHaveLength(0);
  });
  it("keeps trigger tags and the marker when public verification fails", async () => {
    const f = taggedFixture();
    const verify = f.publisher.verify;
    f.publisher.verify = async (id) => ({ ...(await verify(id)), columnIds: [] });
    await expect(runArticles(f.options)).rejects.toThrow("readback mismatch");
    expect(f.tagCalls).toHaveLength(0);
    expect(f.nodes.get("external")?.title).toBe("%External title");
    expect(f.nodes.get("external")?.tags?.some((tag) => tag.tagRemId === "doc")).toBe(true);
  });
  it("detects an adapter that replaces unrelated tags instead of adding the completion tag", async () => {
    const f = taggedFixture();
    f.remnote.updateTags = async (id, add) => {
      (f.nodes.get(id) as ArticleRem).tags = add.map((tagRemId) => ({ tagRemId, name: tagRemId }));
    };
    await expect(runArticles(f.options)).rejects.toThrow("tag readback mismatch");
    expect(f.state.receipts[0]?.stage).toBe("verified");
    expect(f.nodes.get("external")?.title).toBe("%External title");
  });
  it("recovers an interrupted tag switch without publishing or moving the original again", async () => {
    const f = taggedFixture();
    const update = f.remnote.updateTags;
    if (!update) throw new Error("fixture tag adapter missing");
    let fail = true;
    f.remnote.updateTags = async (id, add, remove) => {
      await update(id, add, remove);
      if (fail && remove.includes("doc")) {
        fail = false;
        throw new Error("lost reply after tag removal");
      }
    };
    await expect(runArticles(f.options)).rejects.toThrow("lost reply");
    expect(f.state.receipts[0]?.stage).toBe("verified");
    expect(f.nodes.get("external")?.title).toBe("%External title");
    await runArticles(f.options);
    expect(f.posts()).toBe(1);
    expect(f.nodes.get("external")).toMatchObject({
      title: "External title",
      parentRemId: "elsewhere",
    });
    expect(f.state.receipts[0]?.stage).toBe("archived");
  });
  it("uses Shanghai windows and never catches up missed windows", () => {
    expect(publicationSlot(new Date("2026-11-14T03:29:59Z"))).toBeUndefined();
    expect(publicationSlot(new Date("2026-11-14T03:30:00Z"))).toBe("2026-11-14T11:30+08:00");
    expect(publicationSlot(new Date("2026-11-14T09:44:59Z"))).toBe("2026-11-14T17:30+08:00");
    expect(publicationSlot(new Date("2026-11-14T14:30:00Z"))).toBe("2026-11-14T22:30+08:00");
    expect(publicationSlot(new Date("2026-11-14T14:45:00Z"))).toBeUndefined();
    expect(publicationSlot(new Date("2026-11-14T15:30:00Z"))).toBeUndefined();
  });
  it("scans only marked direct article roots and ignores percent markers in unmarked bodies", async () => {
    const f = fixture();
    f.nodes.set("body-marker", {
      remId: "body-marker",
      title: "%Not an article",
      parentRemId: "group",
    });
    const read = f.remnote.read;
    f.remnote.read = async (id) => {
      if (id === "body-marker") throw new Error("must not scan this body");
      return read(id);
    };
    const scan = await scanArticles(f.remnote, "doc");
    expect(scan.sources.map((s) => s.remId)).toEqual(["one", "two"]);
    expect(scan.sources[0]?.nodes.map((n) => n.text)).toEqual(["first", "detail text"]);
  });
  it("keeps the bound Document identity when its display title is renamed", async () => {
    const f = fixture();
    (f.nodes.get("doc") as RemNode).title = "Renamed Article Source";
    expect((await scanArticles(f.remnote, "doc")).sources.map((source) => source.remId)).toEqual([
      "one",
      "two",
    ]);
  });
  it("preserves percent-prefixed body nodes inside one complete article", async () => {
    const f = fixture();
    (f.nodes.get("child") as RemNode).title = "%nested";
    const scan = await scanArticles(f.remnote, "doc");
    expect(scan.blocked).toEqual([]);
    expect(scan.sources.map((s) => s.remId)).toEqual(["one", "two"]);
    expect(scan.sources[0]?.nodes[1]?.text).toBe("%nested");
  });
  it("blocks publication when the native editor would flatten a sixth list level", async () => {
    const f = fixture();
    let parentRemId = "child";
    for (let depth = 2; depth <= 6; depth++) {
      const remId = `deep-${depth}`;
      f.nodes.set(remId, { remId, title: `Independent level ${depth}`, parentRemId });
      parentRemId = remId;
    }
    await expect(runArticles(f.options)).rejects.toThrow("five list levels");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts).toHaveLength(0);
  });
  it("binds the AI tag into freshness checks without hashing unrelated completion tags", async () => {
    const f = fixture();
    const child = f.nodes.get("child") as ArticleRem;
    child.tags = [{ tagRemId: "ai-tag", name: "AI Generated" }];
    const before = await snapshotArticle(f.remnote, "one", false, "ai-tag");
    child.tags.push({ tagRemId: "other", name: "Other" });
    expect((await snapshotArticle(f.remnote, "one", false, "ai-tag")).fingerprint).toBe(
      before.fingerprint,
    );
    child.tags = [];
    expect((await snapshotArticle(f.remnote, "one", false, "ai-tag")).fingerprint).not.toBe(
      before.fingerprint,
    );
    child.tags = [{ tagRemId: "ai-tag", name: "AI Generated" }];
    f.publisher.check = async () => {
      child.tags = [];
      return { id: "account", name: "Author", urlToken: "author", columnId: "col" };
    };
    await expect(runArticles({ ...f.options, aiGeneratedTagRemId: "ai-tag" })).rejects.toThrow(
      "source changed",
    );
    expect(f.posts()).toBe(0);
  });
  it("keeps AI tag freshness valid through both document and external completion", async () => {
    for (const external of [false, true]) {
      const f = external ? taggedFixture() : fixture();
      const rootId = external ? "external" : "one";
      const root = f.nodes.get(rootId) as ArticleRem;
      root.tags = [...(root.tags ?? []), { tagRemId: "ai-tag", name: "AI Generated" }];
      const result = await runArticles({ ...f.options, aiGeneratedTagRemId: "ai-tag" });
      expect(result).toMatchObject({ published: 1, archived: 1 });
      expect(f.state.receipts[0]?.source.aiGeneratedTagRemId).toBe("ai-tag");
      expect(root.tags.some((tag) => tag.tagRemId === "ai-tag")).toBe(true);
    }
  });
  it("treats double percent as a disabled subtree", async () => {
    const f = fixture();
    (f.nodes.get("one") as RemNode).title = "%%hold";
    expect((await scanArticles(f.remnote, "doc")).sources.map((s) => s.remId)).toEqual(["two"]);
  });
  it("blocks media and unresolved references instead of silently omitting them", async () => {
    const f = fixture();
    (f.nodes.get("child") as RemNode).media = [{}];
    await expect(snapshotArticle(f.remnote, "one")).rejects.toThrow("media");
    delete (f.nodes.get("child") as RemNode).media;
    (f.nodes.get("child") as RemNode).title = "[[unknown]]";
    await expect(snapshotArticle(f.remnote, "one")).rejects.toThrow("unresolved");
  });
  it("resolves explicit references as visible text without reading referenced subtrees", async () => {
    const f = fixture();
    Object.assign(f.nodes.get("child") as RemNode, {
      title: "[[id:elsewhere]]",
      inlineRefs: [{ targetRemId: "elsewhere", text: "label" }],
    });
    expect((await snapshotArticle(f.remnote, "one")).nodes[1]?.text).toBe("label");
  });
  it("publishes one article, verifies it, and moves the same original tree", async () => {
    const f = fixture();
    expect(await runArticles(f.options)).toMatchObject({ published: 1, archived: 1 });
    expect(f.nodes.get("one")).toMatchObject({ parentRemId: "published", title: "first" });
    expect(f.nodes.get("child")?.parentRemId).toBe("one");
    expect(f.nodes.get("two")?.title).toBe("%second");
    expect(f.state.receipts[0]?.stage).toBe("archived");
    expect(f.state.receipts[0]?.url).toBe("https://zhuanlan.zhihu.com/p/101");
    expect(f.persisted()).not.toContain("PRIVATE");
  });
  it("does not publish twice in one slot even if another node is pending", async () => {
    const f = fixture();
    await runArticles(f.options);
    await runArticles(f.options);
    expect(f.posts()).toBe(1);
    f.options.now = new Date("2026-11-14T09:30:00Z");
    await runArticles(f.options);
    expect(f.posts()).toBe(2);
  });
  it("does not mutate anything outside publication windows", async () => {
    const f = fixture();
    f.options.now = new Date("2026-11-14T02:00:00Z");
    expect((await runArticles(f.options)).status).toBe("outside-window");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts).toEqual([]);
  });
  it("does not post if scanning outlasts the original publication window", async () => {
    const f = fixture();
    const result = await runArticles({
      ...f.options,
      currentTime: () => new Date("2026-11-14T03:46:00Z"),
    });
    expect(result.status).toBe("window-ended");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts).toEqual([]);
  });
  it("fails closed when account identity changes", async () => {
    const f = fixture();
    f.publisher.check = async () => ({
      id: "other",
      name: "other",
      urlToken: "other",
      columnId: "col",
    });
    await expect(runArticles(f.options)).rejects.toThrow("account changed");
    expect(f.posts()).toBe(0);
  });
  it("rechecks source edits before the POST", async () => {
    const f = fixture();
    const check = f.publisher.check;
    f.publisher.check = async () => {
      (f.nodes.get("child") as RemNode).title = "edited";
      return check();
    };
    await expect(runArticles(f.options)).rejects.toThrow("source changed");
    expect(f.posts()).toBe(0);
  });
  it("persists the submission fence before posting and never replays an unknown result", async () => {
    const f = fixture();
    f.publisher.publish = async () => {
      expect(JSON.parse(f.persisted()).receipts[0].stage).toBe("submitting");
      throw new Error("connection lost");
    };
    await expect(runArticles(f.options)).rejects.toThrow("connection lost");
    await expect(runArticles(f.options)).rejects.toThrow("unknown publication");
    expect(f.nodes.get("one")?.parentRemId).toBe("doc");
  });
  it("never posts if saving the fence fails", async () => {
    const f = fixture();
    f.options.save = () => {
      throw new Error("disk full");
    };
    await expect(runArticles(f.options)).rejects.toThrow("disk full");
    expect(f.posts()).toBe(0);
  });
  it("retains the source if public content or author does not match", async () => {
    const f = fixture();
    f.publisher.verify = async (id) => ({
      id,
      authorId: "other",
      title: "wrong",
      text: "wrong",
      format: "[]",
      columnIds: ["col"],
      url: `https://zhuanlan.zhihu.com/p/${id}`,
    });
    await expect(runArticles(f.options)).rejects.toThrow("readback mismatch");
    expect(f.state.receipts[0]?.stage).toBe("published");
    expect(f.nodes.get("one")?.parentRemId).toBe("doc");
  });
  it("recovers a verified publication after move failure without posting again", async () => {
    const f = fixture();
    const move = f.remnote.move;
    f.remnote.move = async () => {
      throw new Error("bridge unavailable");
    };
    await expect(runArticles(f.options)).rejects.toThrow("bridge unavailable");
    expect(f.posts()).toBe(1);
    f.remnote.move = move;
    f.options.now = new Date("2026-11-14T05:00:00Z");
    expect((await runArticles(f.options)).archived).toBe(1);
    expect(f.posts()).toBe(1);
  });
  it("recovers after a move succeeded but the marker update failed", async () => {
    const f = fixture();
    const update = f.remnote.updateTitle;
    f.remnote.updateTitle = async () => {
      throw new Error("write failed");
    };
    await expect(runArticles(f.options)).rejects.toThrow("write failed");
    expect(f.nodes.get("one")?.parentRemId).toBe("published");
    expect(f.nodes.get("one")?.title).toBe("%first");
    f.remnote.updateTitle = update;
    await runArticles(f.options);
    expect(f.posts()).toBe(1);
    expect(f.nodes.get("one")?.title).toBe("first");
  });
  it("preserves edits made after posting and does not archive changed content", async () => {
    const f = fixture();
    const verify = f.publisher.verify;
    f.publisher.verify = async (id) => {
      (f.nodes.get("child") as RemNode).title = "new draft";
      return verify(id);
    };
    await expect(runArticles(f.options)).rejects.toThrow("source changed after");
    expect(f.nodes.get("child")?.title).toBe("new draft");
    expect(f.nodes.get("one")?.parentRemId).toBe("doc");
  });
  it("blocks same content in another source node", async () => {
    const f = fixture();
    await runArticles(f.options);
    Object.assign(f.nodes.get("two") as RemNode, { title: "%first" });
    Object.assign(f.nodes.get("child2") as RemNode, { title: "detail text" });
    f.options.now = new Date("2026-11-14T09:30:00Z");
    await expect(runArticles(f.options)).rejects.toThrow("duplicate article");
    expect(f.posts()).toBe(1);
  });
  it("rejects changed list structure even when all visible words match", async () => {
    const f = fixture();
    const verify = f.publisher.verify;
    f.publisher.verify = async (id) => ({ ...(await verify(id)), format: "[flattened]" });
    await expect(runArticles(f.options)).rejects.toThrow("readback mismatch");
    expect(f.nodes.get("one")?.parentRemId).toBe("doc");
  });
  it("requires an exact Document and complete pagination", async () => {
    const f = fixture();
    (f.nodes.get("doc") as RemNode).remType = "text";
    await expect(scanArticles(f.remnote, "doc")).rejects.toThrow("Document");
    (f.nodes.get("doc") as RemNode).remType = "document";
    f.remnote.children = async () => ({ children: [], hasMore: true });
    await expect(scanArticles(f.remnote, "doc")).rejects.toThrow("pagination");
  });
  it("retains a published source until its configured column has accepted it", async () => {
    const f = fixture();
    const verify = f.publisher.verify;
    f.publisher.verify = async (id) => ({ ...(await verify(id)), columnIds: [] });
    await expect(runArticles(f.options)).rejects.toThrow("readback mismatch");
    expect(f.state.receipts[0]?.stage).toBe("published");
    expect(f.nodes.get("one")?.parentRemId).toBe("doc");
    f.publisher.verify = verify;
    await runArticles(f.options);
    expect(f.posts()).toBe(1);
    expect(f.nodes.get("one")?.parentRemId).toBe("published");
  });
  it("adopts an explicitly identified matching manual publication without another POST", async () => {
    const f = fixture();
    const prepared = await f.publisher.prepare((await snapshotArticle(f.remnote, "one")).nodes);
    f.publisher.verify = async (id) => ({
      ...prepared,
      id,
      authorId: "account",
      title: "Author's manual title",
      columnIds: ["col"],
      url: `https://zhuanlan.zhihu.com/p/${id}`,
    });
    const options = { ...f.options, sourceRemId: "one", articleId: "123" };
    expect(await adoptPublishedArticle(options)).toMatchObject({
      status: "adopted",
      published: 0,
      archived: 1,
    });
    expect(f.posts()).toBe(0);
    expect(f.nodes.get("one")).toMatchObject({ title: "first", parentRemId: "published" });
    expect(f.state.receipts[0]?.title).toBe("Author's manual title");
    expect((await adoptPublishedArticle(options)).status).toBe("already-adopted");
    expect(f.state.receipts).toHaveLength(1);
  });
  it("refuses to adopt a manual article with different layout or column", async () => {
    const f = fixture();
    const prepared = await f.publisher.prepare((await snapshotArticle(f.remnote, "one")).nodes);
    f.publisher.verify = async (id) => ({
      ...prepared,
      format: "wrong-layout",
      id,
      authorId: "account",
      columnIds: ["col"],
      url: `https://zhuanlan.zhihu.com/p/${id}`,
    });
    await expect(
      adoptPublishedArticle({ ...f.options, sourceRemId: "one", articleId: "123" }),
    ).rejects.toThrow("does not match");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts).toHaveLength(0);
    expect(f.nodes.get("one")?.parentRemId).toBe("doc");
  });
  it("numbers published articles and calendar days separately in Shanghai", () => {
    const state: ArticleState = { receipts: [] };
    expect(
      seriesTitle(
        "Title",
        new Date("2026-11-13T16:01:00Z"),
        "2026-11-13",
        { publishedCount: 1, maxOrdinal: 1 },
        state,
      ),
    ).toBe("Title（第2 篇 | day 2）");
    expect(
      seriesTitle(
        "Title（第7 篇 | day 5）",
        new Date("2026-11-14T12:00:00Z"),
        "2026-11-13",
        { publishedCount: 4, maxOrdinal: 7 },
        state,
      ),
    ).toBe("Title（第8 篇 | day 2）");
    expect(() =>
      seriesTitle(
        "Title",
        new Date("2026-11-14T12:00:00Z"),
        "2026-02-30",
        { publishedCount: 1, maxOrdinal: 1 },
        state,
      ),
    ).toThrow("start date");
    expect(() =>
      seriesTitle(
        "T".repeat(100),
        new Date("2026-11-14T12:00:00Z"),
        "2026-11-13",
        { publishedCount: 1, maxOrdinal: 1 },
        state,
      ),
    ).toThrow("exceeds");
  });
  it("uses the highest recorded ordinal even if an older article was removed from the column", async () => {
    const f = fixture();
    await runArticles(f.options);
    (f.state.receipts[0] as NonNullable<(typeof f.state.receipts)[0]>).title =
      "first（第9 篇 | day 1）";
    expect(
      seriesTitle(
        "Next",
        new Date("2026-11-14T10:00:00Z"),
        "2026-11-13",
        { publishedCount: 1, maxOrdinal: 1 },
        f.state,
      ),
    ).toBe("Next（第10 篇 | day 2）");
  });
  it("stores a real draft for review without consuming a publication or moving its source", async () => {
    const f = fixture();
    const prepare = f.publisher.prepare;
    const stamps: Array<string | undefined> = [];
    f.publisher.prepare = async (rows, stamp) => {
      stamps.push(stamp);
      return prepare(rows);
    };
    let creates = 0;
    let cloud = {
      id: "777",
      authorId: "account",
      title: "",
      text: "",
      format: "[]",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    };
    f.publisher.seriesStats = async () => ({ publishedCount: 1, maxOrdinal: 1 });
    f.publisher.createDraft = async () => {
      creates++;
      expect(JSON.parse(f.persisted()).drafts[0].status).toBe("creating");
      return { id: "777" };
    };
    f.publisher.readDraft = async () => ({ ...cloud });
    f.publisher.writeDraft = async (id, title, html) => {
      expect(JSON.parse(f.persisted()).drafts[0].draftId).toBe("777");
      cloud = { ...cloud, id, title, text: html.replace(/<[^>]+>/gu, "") };
      return { ...cloud };
    };
    const result = await saveReviewDraft({
      ...f.options,
      seriesStartDate: "2026-11-13",
      sourceRemId: "one",
    });
    expect(result).toMatchObject({
      status: "draft-review",
      title: "first（第2 篇 | day 2）",
      published: 0,
      moved: 0,
    });
    expect(f.state.receipts).toHaveLength(0);
    expect(stamps).toEqual(["待发布"]);
    expect(f.nodes.get("one")?.title).toBe("%first");
    await saveReviewDraft({ ...f.options, seriesStartDate: "2026-11-13", sourceRemId: "one" });
    expect(creates).toBe(1);
    // A held preview is skipped, so another eligible article can still be published.
    const draftCreator = f.publisher.createDraft;
    delete f.publisher.createDraft; // This fixture's creator is scoped to the review draft.
    await runArticles(f.options);
    f.publisher.createDraft = draftCreator;
    expect(f.state.receipts[0]?.source.remId).toBe("two");
    expect(f.posts()).toBe(1);
    cloud.title = "Author edit";
    await expect(
      saveReviewDraft({ ...f.options, seriesStartDate: "2026-11-13", sourceRemId: "one" }),
    ).rejects.toThrow("author edits");
    expect(cloud.title).toBe("Author edit");
  });
  it("persists the first submission time and compares duplicates without a changing footer", async () => {
    const f = fixture();
    const prepare = f.publisher.prepare;
    f.publisher.prepare = async (rows, stamp) => {
      const body = await prepare(rows);
      return stamp
        ? {
            ...body,
            html: `${body.html}<p>首次发布时间：${stamp}</p>`,
            text: `${body.text}${stamp}`,
          }
        : body;
    };
    await runArticles(f.options);
    expect(f.state.receipts[0]).toMatchObject({
      bodyText: "detail text",
      firstPublishedAt: "2026.11.14 11:30",
      text: "detail text2026.11.14 11:30",
    });
    (f.nodes.get("two") as RemNode).title = "%first";
    (f.nodes.get("child2") as RemNode).title = "detail text";
    await expect(
      runArticles({ ...f.options, now: new Date("2026-11-14T09:30:00Z") }),
    ).rejects.toThrow("duplicate article");
    expect(f.posts()).toBe(1);
    expect(f.state.receipts[0]?.firstPublishedAt).toBe("2026.11.14 11:30");
  });
  it("does not recreate a draft after an unknown creation result", async () => {
    const f = fixture();
    let attempts = 0;
    f.publisher.seriesStats = async () => ({ publishedCount: 1, maxOrdinal: 1 });
    f.publisher.createDraft = async () => {
      attempts++;
      throw new Error("connection lost");
    };
    f.publisher.readDraft = async () => {
      throw new Error("must not read an unknown ID");
    };
    f.publisher.writeDraft = async () => {
      throw new Error("must not write");
    };
    await expect(
      saveReviewDraft({ ...f.options, seriesStartDate: "2026-11-13", sourceRemId: "one" }),
    ).rejects.toThrow("connection lost");
    await expect(
      saveReviewDraft({ ...f.options, seriesStartDate: "2026-11-13", sourceRemId: "one" }),
    ).rejects.toThrow("unknown draft");
    expect(attempts).toBe(1);
    expect(f.posts()).toBe(0);
  });
  it("preserves an edited draft only when a new version is explicitly requested", async () => {
    const f = fixture();
    const source = await snapshotArticle(f.remnote, "one");
    const prepared = await f.publisher.prepare(source.nodes);
    f.state.drafts = [{ source, ...prepared, status: "review", draftId: "777" }];
    f.publisher.seriesStats = async () => ({ publishedCount: 1, maxOrdinal: 1 });
    const old = {
      ...prepared,
      id: "777",
      title: "Author edit",
      authorId: "account",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    };
    let fresh = {
      ...old,
      id: "888",
      title: "",
      html: "",
      text: "",
      editorUrl: "https://zhuanlan.zhihu.com/p/888/edit",
    };
    f.publisher.readDraft = async (id) => (id === "777" ? old : fresh);
    f.publisher.createDraft = async () => ({ id: "888" });
    f.publisher.writeDraft = async (_id, title, html) => {
      fresh = { ...fresh, title, html, text: prepared.text };
      return fresh;
    };
    await expect(
      saveReviewDraft({ ...f.options, sourceRemId: "one", seriesStartDate: "2026-11-13" }),
    ).rejects.toThrow("author edits");
    const result = await saveReviewDraft({
      ...f.options,
      sourceRemId: "one",
      seriesStartDate: "2026-11-13",
      newVersion: true,
    });
    expect(result.id).toBe("888");
    expect(old.title).toBe("Author edit");
    expect(f.state.previousDrafts?.[0]?.draftId).toBe("777");
    expect(f.state.drafts?.map((d) => d.draftId)).toEqual(["888"]);
    expect(f.posts()).toBe(0);
  });
  it("publishes an approved draft using the saved cloud identity and final series title", async () => {
    const f = fixture();
    const source = await snapshotArticle(f.remnote, "one");
    const prepared = await f.publisher.prepare(source.nodes);
    const title = "first（第2 篇 | day 2）";
    f.state.drafts = [{ source, ...prepared, title, status: "ready", draftId: "777" }];
    f.publisher.seriesStats = async () => ({ publishedCount: 1, maxOrdinal: 1 });
    f.publisher.readDraft = async () => ({
      ...prepared,
      title,
      id: "777",
      authorId: "account",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    });
    let calls = 0;
    f.publisher.publish = async (actualTitle, _html, draft) => {
      calls++;
      expect(draft?.draftId).toBe("777");
      expect(actualTitle).toBe(title);
      return { id: "777" };
    };
    await runArticles({ ...f.options, seriesStartDate: "2026-11-13" });
    expect(calls).toBe(1);
    expect(f.state.receipts[0]?.articleId).toBe("777");
    expect(f.state.drafts[0]?.status).toBe("published");
    expect(f.nodes.get("one")?.parentRemId).toBe("published");
  });
  it("publishes only the exact approved draft on an explicit manual run outside the schedule", async () => {
    const f = fixture();
    const source = await snapshotArticle(f.remnote, "two");
    const prepared = await f.publisher.prepare(source.nodes);
    f.state.drafts = [{ source, ...prepared, status: "review", draftId: "777" }];
    f.publisher.readDraft = async () => ({
      ...prepared,
      id: "777",
      authorId: "account",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    });
    let posts = 0;
    f.publisher.publish = async (_title, _html, draft) => {
      posts++;
      expect(draft?.draftId).toBe("777");
      return { id: "777" };
    };
    const options = {
      ...f.options,
      now: new Date("2026-11-14T10:05:00Z"),
      manualSourceRemId: "two",
    };
    await expect(runArticles(options)).rejects.toThrow("exact approved");
    expect(posts).toBe(0);
    const reviewed = f.state.drafts[0];
    if (!reviewed) throw new Error("missing fixture draft");
    reviewed.status = "ready";
    expect(await runArticles(options)).toMatchObject({ published: 1, archived: 1 });
    expect(posts).toBe(1);
    expect(f.state.receipts[0]?.slot).toMatch(/^manual:two:/u);
    expect(f.nodes.get("one")?.title).toBe("%first");
    expect(f.nodes.get("two")?.parentRemId).toBe("published");
  });
  it("preserves cloud edits made after draft approval", async () => {
    const f = fixture();
    const source = await snapshotArticle(f.remnote, "one");
    const prepared = await f.publisher.prepare(source.nodes);
    f.state.drafts = [{ source, ...prepared, status: "ready", draftId: "777" }];
    f.publisher.readDraft = async () => ({
      ...prepared,
      text: "Author changed body",
      id: "777",
      authorId: "account",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    });
    await expect(runArticles(f.options)).rejects.toThrow("cloud draft changed");
    expect(f.posts()).toBe(0);
  });
  it("persists a newly provisioned cloud ID and recovers publication by readback without replay", async () => {
    const f = fixture();
    let creates = 0;
    let attempts = 0;
    f.publisher.createDraft = async () => {
      creates++;
      return { id: "777" };
    };
    f.publisher.readDraft = async () => ({
      id: "777",
      authorId: "account",
      title: "",
      text: "",
      format: "[]",
      state: "draft",
      editorUrl: "https://zhuanlan.zhihu.com/p/777/edit",
    });
    f.publisher.publish = async (_title, _html, draft) => {
      attempts++;
      expect(draft?.draftId).toBe("777");
      expect(draft?.cloudBefore?.title).toBe("");
      expect(JSON.parse(f.persisted()).receipts[0].articleId).toBe("777");
      throw new Error("response lost after publish");
    };
    await expect(runArticles(f.options)).rejects.toThrow("response lost");
    expect(f.state.receipts[0]?.stage).toBe("submitting");
    const recovered = await runArticles(f.options);
    expect(recovered.archived).toBe(1);
    expect(f.state.receipts[0]?.stage).toBe("archived");
    expect(attempts).toBe(1);
    expect(creates).toBe(1);
  });
  it("does not replay a known draft when public readback still says unpublished", async () => {
    const f = fixture();
    const source = await snapshotArticle(f.remnote, "one");
    const prepared = await f.publisher.prepare(source.nodes);
    f.state.receipts.push({
      source,
      ...prepared,
      stage: "submitting",
      articleId: "777",
      columnId: "col",
      slot: "earlier",
    });
    f.publisher.verify = async () => {
      throw new Error("article_not_published");
    };
    await expect(runArticles(f.options)).rejects.toThrow("article_not_published");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts[0]?.stage).toBe("submitting");
  });
  it("detects repeated content despite the publication series suffix", async () => {
    const f = fixture();
    await runArticles(f.options);
    const receipt = f.state.receipts[0];
    if (!receipt) throw new Error("missing fixture receipt");
    receipt.title = "first（第1 篇 | day 1）";
    const second = f.nodes.get("two");
    const body = f.nodes.get("child2");
    if (!second || !body) throw new Error("missing fixture nodes");
    second.title = "%first";
    body.title = "detail text";
    await expect(
      runArticles({ ...f.options, now: new Date("2026-11-14T09:30:00Z") }),
    ).rejects.toThrow("duplicate article");
    expect(f.posts()).toBe(1);
  });
});
