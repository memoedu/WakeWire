import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RemNode } from "./remnote-todo.js";
import {
  type ArticlePublisher,
  type ArticleReader,
  type ArticleState,
  type CloudDraft,
  snapshotArticle,
} from "./remnote-zhihu.js";
import { archivePreparedArticles, publishPreparedArticles } from "./remnote-zhihu-publish.js";
import { articleFeedback } from "./remnote-zhihu-review.js";

async function fixture() {
  const nodes = new Map<string, RemNode>([
    ["doc", { remId: "doc", title: "Source document", remType: "document" }],
    ["source", { remId: "source", title: "%Prepared article", parentRemId: "doc" }],
    [
      "body",
      {
        remId: "body",
        title: "Original complete body for a prepared article",
        parentRemId: "source",
      },
    ],
  ]);
  let mutations = 0,
    posts = 0,
    saves = 0;
  const reader: ArticleReader = {
    async read(id) {
      const row = nodes.get(id);
      if (!row) throw Error("missing source");
      return structuredClone(row);
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
      mutations++;
      nodes.set("bucket", { remId: "bucket", title, parentRemId });
      return "bucket";
    },
    async updateTitle(id, title) {
      mutations++;
      Object.assign(nodes.get(id) as RemNode, { title });
    },
    async move(id, parentRemId, expected) {
      const row = nodes.get(id) as RemNode;
      if (row.parentRemId !== expected) throw Error("parent changed");
      mutations++;
      row.parentRemId = parentRemId;
    },
  };
  const source = await snapshotArticle(reader, "source");
  const body = source.nodes
    .slice(1)
    .map((n) => n.text)
    .join("");
  const text = (stamp?: string) => body + (stamp ? `\n\nFirst published: ${stamp}` : "");
  const cloud: CloudDraft = {
    id: "900",
    authorId: "account",
    title: "Prepared article",
    text: text("待发布"),
    format: "native-format",
    state: "draft",
    editorUrl: "https://zhuanlan.zhihu.com/p/900/edit",
  };
  const state: ArticleState = {
    receipts: [],
    drafts: [
      {
        source,
        title: cloud.title,
        text: cloud.text,
        format: cloud.format,
        html: `<p>${cloud.text}</p>`,
        status: "ready",
        draftId: cloud.id,
        reviewMode: "automatic",
      },
    ],
    reviews: [
      {
        sourceRemId: source.remId,
        fingerprint: source.fingerprint,
        draftId: cloud.id,
        title: cloud.title,
        slot: "2026-11-15T11:30+08:00",
        checkedAt: "2026-11-15T01:30:00Z",
        status: "approved",
        issues: [],
      },
    ],
  };
  const publisher: ArticlePublisher = {
    async prepare(_rows, stamp) {
      return {
        title: "Prepared article",
        text: text(stamp),
        html: `<p>${text(stamp)}</p>`,
        format: "native-format",
      };
    },
    async check() {
      return { id: "account", name: "Author", urlToken: "author", columnId: "column" };
    },
    async readDraft() {
      return structuredClone(cloud);
    },
    async publish(title, html, draft) {
      expect(state.receipts.at(-1)).toMatchObject({ stage: "submitting", articleId: "900" });
      expect(saves).toBeGreaterThan(0);
      expect(draft?.draftId).toBe("900");
      posts++;
      Object.assign(cloud, { title, text: html.slice(3, -4), state: "published" });
      return { id: "900" };
    },
    async verify(id) {
      if (cloud.state !== "published") throw Error("article not published");
      return {
        id,
        authorId: cloud.authorId,
        title: cloud.title,
        text: cloud.text,
        format: cloud.format,
        columnIds: ["column"],
        url: `https://zhuanlan.zhihu.com/p/${id}`,
      };
    },
  };
  const save = () => {
    saves++;
  };
  const options = {
    state,
    publisher,
    save,
    now: new Date("2026-11-15T03:30:00Z"),
    accountId: "account",
    columnId: "column",
  };
  const archive = { state, save, documentRemId: "doc", reader: async () => reader };
  return {
    nodes,
    reader,
    state,
    publisher,
    cloud,
    options,
    archive,
    posts: () => posts,
    mutations: () => mutations,
  };
}

describe("prepared Zhihu publication without RemNote", () => {
  it("persists the expected catalog state and blocks unknown-result replay when it is lost", async () => {
    for (const catalogSaved of [true, false]) {
      const f = await fixture();
      const prepare = f.publisher.prepare.bind(f.publisher);
      const verify = f.publisher.verify.bind(f.publisher);
      f.publisher.prepare = async (...args) => ({
        ...(await prepare(...args)),
        tableOfContents: true,
      });
      f.publisher.verify = async (id) => ({
        ...(await verify(id)),
        tableOfContents: catalogSaved,
      });
      if (catalogSaved) {
        expect(await publishPreparedArticles(f.options)).toMatchObject({ published: 1 });
      } else {
        await expect(publishPreparedArticles(f.options)).rejects.toThrow("readback mismatch");
        await expect(publishPreparedArticles(f.options)).rejects.toThrow("readback mismatch");
      }
      expect(f.state.receipts[0]?.tableOfContents).toBe(true);
      expect(f.posts()).toBe(1);
    }
  });

  for (const action of ["run", "publish-now"] as const)
    it(`runs the actual ${action} CLI with an unreachable RemNote endpoint`, () => {
      const parent =
        process.platform === "win32" && fs.existsSync("D:/Quarantine")
          ? "D:/Quarantine"
          : os.tmpdir();
      const home = fs.mkdtempSync(path.join(parent, "wakewire-offline-cli-"));
      const relative = path.relative(path.resolve(parent), path.resolve(home));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw Error("Invalid isolated fixture path");
      try {
        const file = path.join(home, "config.json");
        fs.writeFileSync(
          file,
          JSON.stringify({
            documentRemId: "doc",
            mcpUrl: "http://127.0.0.1:1/mcp",
            python: process.execPath,
            cookieSnapshot: path.join(home, "not-used.json"),
            accountId: "account",
            columnId: "column",
            requirePreflight: true,
          }),
        );
        const entry = fileURLToPath(new URL("./remnote-zhihu-cli.ts", import.meta.url));
        const actual = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            entry,
            action,
            file,
            ...(action === "publish-now" ? ["not-approved"] : []),
          ],
          { encoding: "utf8", timeout: 30000 },
        );
        expect(actual.error).toBeUndefined();
        if (action === "run") {
          expect(actual.status).toBe(0);
          expect(JSON.parse(actual.stdout).published).toBe(0);
        } else {
          expect(actual.status).toBe(1);
          expect(actual.stderr).toContain("requires the exact approved cloud draft");
        }
        expect(actual.stderr).not.toMatch(/ECONNREFUSED|fetch failed|knowledge base/u);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }, 45000);
  it("publishes the approved frozen draft before any RemNote call, and defers an offline archive", async () => {
    const f = await fixture();
    const published = await publishPreparedArticles(f.options);
    expect(published).toMatchObject({
      status: "published",
      published: 1,
      archived: 0,
      archivePending: 1,
    });
    expect(f.mutations()).toBe(0);
    const archived = await archivePreparedArticles({
      ...f.archive,
      reader: async () => {
        throw Error("wrong knowledge base");
      },
    });
    expect(archived).toEqual({ archived: 0, archivePending: 1 });
    expect(f.state.receipts[0]?.stage).toBe("verified");
    expect(f.posts()).toBe(1);
    const feedback = articleFeedback(f.state, f.options.now, "publish");
    expect(feedback.articles).toHaveLength(0);
    expect(feedback.generalIssues[0]).toContain("已发布");
  });
  it("recovers only archival after the source library reconnects without posting again", async () => {
    const f = await fixture();
    await publishPreparedArticles(f.options);
    await archivePreparedArticles({
      ...f.archive,
      reader: async () => {
        throw Error("offline");
      },
    });
    expect(await publishPreparedArticles(f.options)).toMatchObject({
      status: "slot-consumed",
      published: 0,
    });
    expect(await archivePreparedArticles(f.archive)).toEqual({ archived: 1, archivePending: 0 });
    expect(f.nodes.get("source")).toMatchObject({
      parentRemId: "bucket",
      title: "Prepared article",
    });
    expect(f.posts()).toBe(1);
  });
  it("publishes a frozen version even if the original changes, and preserves those source edits during archival", async () => {
    const f = await fixture();
    (f.nodes.get("body") as RemNode).title = "New author edit after preparation";
    await publishPreparedArticles(f.options);
    expect(f.cloud.text).toContain("Original complete body");
    expect(await archivePreparedArticles(f.archive)).toMatchObject({
      archived: 0,
      archivePending: 1,
    });
    expect(f.mutations()).toBe(0);
    expect(f.nodes.get("body")?.title).toBe("New author edit after preparation");
  });
  it("preserves intervening edits in the real cloud draft", async () => {
    const f = await fixture();
    f.cloud.text = "Author changed the cloud draft";
    await expect(publishPreparedArticles(f.options)).rejects.toThrow("author edits were preserved");
    expect(f.posts()).toBe(0);
    expect(f.state.receipts).toHaveLength(0);
  });
  it("rejects a switched Zhihu account or column before submission", async () => {
    const f = await fixture();
    f.publisher.check = async () => ({
      id: "foreign",
      name: "Other",
      urlToken: "other",
      columnId: "column",
    });
    await expect(publishPreparedArticles(f.options)).rejects.toThrow("account or column changed");
    expect(f.posts()).toBe(0);
  });
  it("requires a slot and matching frozen review fingerprint for automatic publication", async () => {
    const f = await fixture();
    for (const r of f.state.reviews ?? []) r.fingerprint = "changed";
    expect(await publishPreparedArticles(f.options)).toMatchObject({
      status: "blocked",
      published: 0,
    });
    expect(
      await publishPreparedArticles({ ...f.options, now: new Date("2026-11-15T09:30:00Z") }),
    ).toMatchObject({ published: 0 });
    expect(f.posts()).toBe(0);
  });
  it("does not publish a held or unreviewed draft", async () => {
    const f = await fixture();
    for (const d of f.state.drafts ?? []) d.status = "review";
    expect(await publishPreparedArticles(f.options)).toMatchObject({
      status: "draft-review",
      published: 0,
    });
    expect(f.posts()).toBe(0);
  });
  it("supports explicit make-up publication of an approved draft after its original slot", async () => {
    const f = await fixture();
    expect(
      await publishPreparedArticles({
        ...f.options,
        now: new Date("2026-11-15T15:55:00Z"),
        manualSourceRemId: "source",
      }),
    ).toMatchObject({ published: 1 });
    expect(f.state.receipts[0]?.slot).toMatch(/^manual:source:/u);
    expect(f.state.receipts[0]?.firstPublishedAt).toBe("2026.11.15 23:55");
    expect(
      await publishPreparedArticles({ ...f.options, manualSourceRemId: "source" }),
    ).toMatchObject({ published: 0 });
    expect(f.posts()).toBe(1);
  });
  it("never publishes after the allowed slot ends during preparation", async () => {
    const f = await fixture();
    expect(
      await publishPreparedArticles({
        ...f.options,
        currentTime: () => new Date("2026-11-15T03:45:00Z"),
      }),
    ).toMatchObject({ status: "window-ended", published: 0 });
    expect(f.state.receipts).toHaveLength(0);
  });
  it("does not submit if the durable fence cannot be saved", async () => {
    const f = await fixture();
    await expect(
      publishPreparedArticles({
        ...f.options,
        save: () => {
          throw Error("disk unavailable");
        },
      }),
    ).rejects.toThrow("disk unavailable");
    expect(f.posts()).toBe(0);
  });
  it("does not replay an unknown publication result on the original known draft ID", async () => {
    const f = await fixture();
    let calls = 0;
    f.publisher.publish = async () => {
      calls++;
      throw Error("timeout");
    };
    await expect(publishPreparedArticles(f.options)).rejects.toThrow("timeout");
    expect(f.state.receipts[0]).toMatchObject({ stage: "submitting", articleId: "900" });
    await expect(publishPreparedArticles(f.options)).rejects.toThrow("not published");
    expect(calls).toBe(1);
  });
  it("only verifies a successful post whose response was lost", async () => {
    const f = await fixture(),
      publish = f.publisher.publish;
    f.publisher.publish = async (...args) => {
      await publish(...args);
      throw Error("response lost");
    };
    await expect(publishPreparedArticles(f.options)).rejects.toThrow("response lost");
    expect(await publishPreparedArticles(f.options)).toMatchObject({
      published: 0,
      archivePending: 1,
    });
    expect(f.posts()).toBe(1);
    expect(f.state.receipts[0]?.stage).toBe("verified");
  });
  it("recognizes a manually published known draft without reposting", async () => {
    const f = await fixture();
    f.cloud.state = "published";
    expect(await publishPreparedArticles(f.options)).toMatchObject({
      status: "published",
      published: 0,
      archivePending: 1,
    });
    expect(f.posts()).toBe(0);
    expect(f.state.drafts?.[0]?.status).toBe("published");
  });
  it("retains the known publication and skips archival when public readback is wrong", async () => {
    const f = await fixture(),
      verify = f.publisher.verify;
    f.publisher.verify = async (id) => ({ ...(await verify(id)), columnIds: [] });
    await expect(publishPreparedArticles(f.options)).rejects.toThrow("readback mismatch");
    expect(f.state.receipts[0]?.stage).toBe("published");
    expect(f.mutations()).toBe(0);
  });
});
