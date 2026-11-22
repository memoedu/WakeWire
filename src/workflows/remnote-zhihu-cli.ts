import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { RemNoteMcp } from "./remnote-todo-cli.js";
import {
  type ArticleDraft,
  type ArticleNode,
  type ArticlePublisher,
  type ArticleReader,
  type ArticleRem,
  type ArticleState,
  adoptPublishedArticle,
  type CloudDraft,
  type MentionBinding,
  nextPublicationSlot,
  publicationSlot,
  reviewSlot,
  runArticles,
  type SeriesStats,
  saveReviewDraft,
  scanArticles,
} from "./remnote-zhihu.js";
import { underlineSnapshotContent } from "./remnote-zhihu-native.js";
import {
  archivePreparedArticles,
  preparedPublicationSummary,
  publishPreparedArticles,
} from "./remnote-zhihu-publish.js";
import { articleFeedback, auditArticles, reviewIssue } from "./remnote-zhihu-review.js";

const Config = z.object({
  documentRemId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  documentTitle: z.string().optional(),
  knowledgeBaseId: z.string().min(1).optional(),
  mcpUrl: z.url(),
  python: z.string().min(1),
  cookieSnapshot: z.string().min(1),
  accountId: z.string().min(1),
  columnId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  seriesStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
  publishedTagRemId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
  aiGeneratedTagRemId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/u)
    .optional(),
  mentionBindings: z
    .array(z.object({ name: z.string().min(1).max(100), id: z.string().regex(/^[a-f0-9]{32}$/u) }))
    .optional(),
  requirePreflight: z.boolean().optional(),
  controlledSync: z.boolean().optional(),
});
type Config = z.infer<typeof Config>;

const ArticleRemSchema = z.object({
  remId: z.string().min(1),
  title: z.string(),
  headline: z.string().optional(),
  parentRemId: z.string().optional(),
  inlineRefs: z.array(z.object({ targetRemId: z.string(), text: z.string() })).optional(),
  media: z.array(z.unknown()).optional(),
  remType: z.string().optional(),
  tags: z.array(z.object({ tagRemId: z.string().min(1), name: z.string() })).optional(),
});

/** Article-only tag extension; the existing command adapter remains unchanged. */
export class ArticleRemNoteMcp extends RemNoteMcp implements ArticleReader {
  override async connect(url: string, knowledgeBaseId?: string): Promise<void> {
    await super.connect(url);
    if (knowledgeBaseId) {
      const status = (await this.call("remnote_status", {})) as { knowledgeBaseId?: string };
      if (status.knowledgeBaseId !== knowledgeBaseId)
        throw new Error("RemNote knowledge base changed; source library is not connected");
    }
  }
  async richText(remId: string): Promise<Array<Record<string, unknown>>> {
    let raw: unknown;
    try {
      raw = await this.call("personalwebsite_richtext", { remId, preserveReferences: true });
    } catch (error) {
      const snapshot = z
        .object({
          complete: z.literal(true),
          nodes: z.array(
            z.object({
              remId: z.string(),
              inlineRefs: z
                .array(z.object({ targetRemId: z.string(), text: z.string() }))
                .optional(),
              nativeSnapshot: z.object({ text: z.array(z.unknown()) }),
            }),
          ),
        })
        .parse(await this.call("personalwebsite_nodes", { remIds: [remId] }));
      const node = snapshot.nodes[0];
      if (snapshot.nodes.length !== 1 || node?.remId !== remId)
        throw new Error("native rich text identity changed");
      if (
        !node.nativeSnapshot.text.some(
          (p) => p && typeof p === "object" && "u" in p && typeof p.u === "boolean",
        )
      )
        throw error;
      return underlineSnapshotContent(node.nativeSnapshot.text, node.inlineRefs ?? []);
    }
    const result = z
      .object({ remId: z.string(), content: z.array(z.record(z.string(), z.unknown())) })
      .parse(raw);
    if (result.remId !== remId) throw new Error("native rich text identity changed");
    return result.content;
  }
  override async read(remId: string): Promise<ArticleRem> {
    return ArticleRemSchema.parse(
      await this.call("remnote_read_note", {
        remId,
        depth: 0,
        contentMode: "none",
        view: "full",
        includeMediaMetadata: true,
        renderNativeMarkdown: true,
      }),
    );
  }
  async tagged(tagRemId: string, cursor?: string) {
    return z
      .object({
        results: z.array(ArticleRemSchema),
        hasMore: z.boolean().optional(),
        nextCursor: z.string().optional(),
        truncated: z.boolean().optional(),
      })
      .parse(
        await this.call("remnote_search_by_tag", {
          tagRemId,
          resultMode: "tagged",
          contentMode: "none",
          limit: 150,
          view: "full",
          ...(cursor ? { cursor } : {}),
        }),
      );
  }
  async updateTags(
    remId: string,
    addTagRemIds: string[],
    removeTagRemIds: string[],
  ): Promise<void> {
    await this.call("remnote_update_tags", { remId, addTagRemIds, removeTagRemIds });
  }
}

export class ZhihuPublisher implements ArticlePublisher {
  constructor(private readonly config: Config) {}
  private async call<T>(
    action: string,
    args: Record<string, unknown> = {},
    helper = false,
  ): Promise<T> {
    const script = fileURLToPath(
      new URL(
        helper ? "../../scripts/zhihu_sync.py" : "../../scripts/zhihu-client.py",
        import.meta.url,
      ),
    );
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.python, ["-X", "utf8", script], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8");
      let stdout = "";
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value as T);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error("Zhihu client timed out; never replay a publish"));
      }, 90000);
      child.on("error", () => finish(new Error("Zhihu client could not start")));
      child.stdin.on("error", () => finish(new Error("Zhihu client input failed")));
      child.stdout.on("data", (data: string) => {
        stdout += data;
        if (stdout.length > 2000000) {
          child.kill();
          finish(new Error("Zhihu client response too large"));
        }
      });
      child.stderr.resume(); // Upstream exceptions must never leak credentials or HTTP response bodies.
      child.on("close", (code) => {
        try {
          const result = JSON.parse(stdout) as { ok: boolean; data: T; error?: string };
          if (!result.ok || code !== 0)
            return finish(
              new Error(
                `Zhihu client failed: ${/^[A-Za-z_]+$/u.test(result.error ?? "") ? result.error : "invalid_response"}`,
              ),
            );
          finish(undefined, result.data);
        } catch {
          finish(new Error("Zhihu client returned invalid JSON"));
        }
      });
      child.stdin.end(
        JSON.stringify({
          action,
          snapshotPath: this.config.cookieSnapshot,
          expectedAccountId: this.config.accountId,
          columnId: this.config.columnId,
          ...args,
        }),
      );
    });
  }
  prepare(
    nodes: ArticleNode[],
    firstPublishedAt?: string,
    seriesLabel?: string,
  ): Promise<{
    title: string;
    html: string;
    text: string;
    format: string;
    hierarchyMode?: string;
    tableOfContents?: boolean;
    mentionBindings?: MentionBinding[];
  }> {
    return this.call("prepare", {
      nodes,
      ...(firstPublishedAt ? { firstPublishedAt } : {}),
      ...(seriesLabel ? { seriesLabel } : {}),
      ...(this.config.aiGeneratedTagRemId
        ? { aiGeneratedTagRemId: this.config.aiGeneratedTagRemId }
        : {}),
      ...(this.config.mentionBindings ? { mentionBindings: this.config.mentionBindings } : {}),
    });
  }
  check(): Promise<{ id: string; name: string; urlToken: string; columnId: string }> {
    return this.call("check");
  }
  publish(title: string, html: string, draft?: ArticleDraft): Promise<{ id: string }> {
    return this.call("publish", {
      title,
      html,
      ...(draft?.draftId ? { draftId: draft.draftId, expected: draft.cloudBefore ?? draft } : {}),
    });
  }
  seriesStats(): Promise<SeriesStats> {
    return this.call("series");
  }
  createDraft(): Promise<{ id: string }> {
    return this.call("create-draft");
  }
  syncModel<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.call(action, args, true);
  }
  updatePublished(args: Record<string, unknown>): Promise<{ id: string }> {
    return this.call("update-published", args);
  }
  restoreRevisionColumn(args: Record<string, unknown>): Promise<{ id: string }> {
    return this.call("restore-revision-column", args);
  }
  readDraft(articleId: string): Promise<CloudDraft> {
    return this.call("read-draft", { articleId });
  }
  writeDraft(
    articleId: string,
    title: string,
    html: string,
    expected: CloudDraft,
  ): Promise<CloudDraft> {
    return this.call("write-draft", { articleId, title, html, expected });
  }
  verify(articleId: string): Promise<{
    id: string;
    authorId: string;
    title: string;
    text: string;
    format: string;
    tableOfContents?: boolean;
    columnIds: string[];
    url: string;
  }> {
    return this.call("verify", { articleId });
  }
}

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
}

async function controlledHook(
  action: string,
  configFile: string,
  state: ArticleState,
  slot?: string,
): Promise<{
  updated?: number;
  checked?: number;
  synchronized?: number;
  revisions?: number;
  updates?: Array<{ id: string; title: string; url: string; kind: string }>;
}> {
  try {
    return await new Promise((resolve, reject) => {
      const script = fileURLToPath(
        new URL("../../scripts/zhihu-controlled-sync.mjs", import.meta.url),
      );
      const child = spawn(
        process.execPath,
        [script, action, configFile, String(process.pid), ...(slot ? [slot] : [])],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.setEncoding("utf8");
      let output = "";
      let stopped: string | undefined;
      const stop = (reason: string) => {
        if (stopped) return;
        stopped = reason;
        if (process.platform === "win32" && child.pid) {
          // Terminate only this owned hook and its API helpers before releasing the workflow lock.
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => child.kill());
        } else child.kill();
      };
      const timer = setTimeout(() => {
        stop("sync_hook_timeout_requires_review");
      }, 600000);
      child.stdout.on("data", (data: string) => {
        output += data;
        if (output.length > 16384) {
          stop("sync_hook_output_invalid");
        }
      });
      child.stderr.setEncoding("utf8");
      let diagnostic = "";
      child.stderr.on("data", (data: string) => {
        if (diagnostic.length < 4096) diagnostic += data;
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("sync_hook_failed"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (stopped) {
          reject(new Error(stopped));
          return;
        }
        if (code !== 0) {
          const reason = /controlled_sync_failed:([a-z_]+)/u.exec(diagnostic)?.[1];
          reject(new Error(reason ? `sync_${reason}` : "sync_hook_failed"));
          return;
        }
        try {
          resolve(JSON.parse(output));
        } catch {
          reject(new Error("sync_hook_failed"));
        }
      });
    });
  } finally {
    // The child owns the same workflow state under our existing run lock.
    const fresh = readState(path.join(path.dirname(configFile), "state.json"));
    for (const key of Object.keys(state))
      if (!(key in fresh)) delete (state as unknown as Record<string, unknown>)[key];
    Object.assign(state, fresh);
  }
}

function lock(file: string): () => void {
  try {
    const descriptor = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    fs.closeSync(descriptor);
    return () => fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = z
      .object({ pid: z.number().int().positive() })
      .parse(JSON.parse(fs.readFileSync(file, "utf8")));
    try {
      process.kill(previous.pid, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
        fs.unlinkSync(file);
        return lock(file);
      }
      throw probe;
    }
    throw new Error("another Zhihu workflow process owns the lock");
  }
}

function readState(file: string): ArticleState {
  if (!fs.existsSync(file)) return { receipts: [] };
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as ArticleState;
  if (!Array.isArray(state.receipts)) throw new Error("invalid article state");
  for (const r of state.receipts) {
    if (
      !r.source?.remId ||
      (!r.source.parentRemId && !r.source.tagTrigger) ||
      !r.source.fingerprint ||
      !r.source.nodes?.length ||
      !r.html ||
      !r.text ||
      !r.title ||
      !r.format ||
      !r.columnId ||
      !r.slot ||
      !["submitting", "published", "verified", "archived"].includes(r.stage) ||
      (r.stage !== "submitting" && !/^\d+$/u.test(r.articleId ?? ""))
    )
      throw new Error("invalid article receipt; state was preserved");
  }
  const route = z.object({
    triggerTagRemId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
    publishedTagRemId: z.string().regex(/^[A-Za-z0-9_-]+$/u),
  });
  for (const source of [
    ...state.receipts.map((item) => item.source),
    ...(state.drafts ?? []).map((item) => item.source),
  ])
    if (source?.tagTrigger) route.parse(source.tagTrigger);
  if (state.drafts !== undefined) {
    if (!Array.isArray(state.drafts)) throw new Error("invalid draft state");
    for (const draft of state.drafts)
      if (
        !draft.source?.remId ||
        !draft.source.fingerprint ||
        !draft.title ||
        !draft.html ||
        !draft.text ||
        !draft.format ||
        !["creating", "review", "ready", "published"].includes(draft.status) ||
        (draft.status !== "creating" && !/^\d+$/u.test(draft.draftId ?? ""))
      )
        throw new Error("invalid saved draft; state was preserved");
  }
  if (state.reviews !== undefined)
    z.array(
      z
        .object({
          sourceRemId: z.string().min(1),
          title: z.string(),
          slot: z.string().regex(/^\d{4}-\d{2}-\d{2}T(11|17|22):30\+08:00$/u),
          checkedAt: z.iso.datetime(),
          fingerprint: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
          draftId: z.string().regex(/^\d+$/u).optional(),
          editorUrl: z.string().optional(),
          status: z.enum(["approved", "blocked", "resolved", "withdrawn"]),
          issues: z.array(z.string()),
        })
        .refine((r) => r.status !== "approved" || Boolean(r.fingerprint && r.draftId)),
    ).parse(state.reviews);
  return state;
}

async function main(): Promise<void> {
  const [action, configFile, sourceRemId, articleId] = process.argv.slice(2);
  if (
    !action ||
    ![
      "check",
      "scan",
      "preview",
      "run",
      "tick",
      "audit",
      "publish-now",
      "adopt",
      "draft",
      "approve-draft",
    ].includes(action) ||
    !configFile ||
    !path.isAbsolute(configFile)
  )
    throw new Error(
      "usage: remnote-zhihu-cli.js check|scan|preview|run|tick|audit|publish-now|adopt|draft|approve-draft <absolute-config.json> [sourceRemId articleId]",
    );
  const config = Config.parse(JSON.parse(fs.readFileSync(configFile, "utf8")));
  for (const target of [config.python, config.cookieSnapshot])
    if (!path.isAbsolute(target)) throw new Error("runtime paths must be absolute");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.mcpUrl).hostname))
    throw new Error("RemNote endpoint must be loopback");
  const home = path.dirname(configFile);
  if (action === "publish-now" && !sourceRemId)
    throw new Error("publish-now requires an exact approved source");
  const release = [
    "run",
    "tick",
    "audit",
    "publish-now",
    "adopt",
    "draft",
    "approve-draft",
  ].includes(action)
    ? lock(path.join(home, "run.lock"))
    : () => {};
  const remnote = new ArticleRemNoteMcp();
  let remnoteConnected = false;
  const reader = async () => {
    if (!remnoteConnected) {
      await remnote.connect(config.mcpUrl, config.knowledgeBaseId);
      remnoteConnected = true;
    }
    return remnote;
  };
  const now = new Date();
  const preparedPublication =
    action === "publish-now" ||
    Boolean(
      config.requirePreflight && (action === "run" || (action === "tick" && publicationSlot(now))),
    );
  let activeState: ArticleState | undefined;
  try {
    if (["run", "tick", "audit", "publish-now", "adopt", "draft", "approve-draft"].includes(action))
      activeState = readState(path.join(home, "state.json"));
    if (!preparedPublication && action !== "approve-draft") await reader();
    const publisher = new ZhihuPublisher(config);
    if (
      ["run", "tick", "audit", "publish-now", "adopt", "draft", "approve-draft"].includes(action)
    ) {
      const stateFile = path.join(home, "state.json");
      const state = activeState as ArticleState;
      activeState = state;
      const shared = {
        remnote,
        publisher,
        documentRemId: config.documentRemId,
        accountId: config.accountId,
        columnId: config.columnId,
        ...(config.publishedTagRemId ? { publishedTagRemId: config.publishedTagRemId } : {}),
        ...(config.aiGeneratedTagRemId ? { aiGeneratedTagRemId: config.aiGeneratedTagRemId } : {}),
        state,
        ...(config.requirePreflight ? { requirePreflight: true } : {}),
        save: () => atomicJson(stateFile, state),
      };
      if (preparedPublication) {
        const revision =
          config.controlledSync && action !== "publish-now"
            ? await controlledHook("publish", configFile, state, publicationSlot(new Date()))
            : {};
        const result = await publishPreparedArticles({
          ...shared,
          now,
          currentTime: () => new Date(),
          ...(action === "publish-now" ? { manualSourceRemId: sourceRemId as string } : {}),
          ...(config.seriesStartDate ? { seriesStartDate: config.seriesStartDate } : {}),
        });
        if (result.status === "published") {
          delete state.reviewFailure;
          shared.save();
        }
        const report = () => {
          const finishedAt = new Date().toISOString();
          const baseFeedback = articleFeedback(
            state,
            new Date(),
            "publish",
            publicationSlot(new Date()),
          );
          const blocking = result.blockingIssues ?? [];
          const feedback = {
            ...baseFeedback,
            generalIssues: [...baseFeedback.generalIssues, ...blocking],
            issues: baseFeedback.issues + blocking.length,
            publications: [...result.publications, ...(revision.updates ?? [])],
          };
          const summary = preparedPublicationSummary(result, revision.updated ?? 0);
          const value = {
            at: finishedAt,
            finishedAt,
            ...result,
            status: revision.updated ? "published" : result.status,
            updated: revision.updated ?? 0,
            issues: feedback.issues,
            summary,
            feedback,
          };
          atomicJson(path.join(home, "last-run.json"), value);
          return value;
        };
        report(); // Persist publication status before any attempt to connect to RemNote.
        Object.assign(result, await archivePreparedArticles({ ...shared, reader }));
        if (config.controlledSync) await controlledHook("seed", configFile, state);
        console.log(JSON.stringify(report()));
        return;
      }
      const audit = action === "audit" || (action === "tick" && !publicationSlot(now));
      if (audit) {
        if (!config.seriesStartDate) throw new Error("series start date is required for review");
        const recovered = await archivePreparedArticles({ ...shared, reader });
        const slot = reviewSlot(now) ?? nextPublicationSlot(now);
        const synchronization = config.controlledSync
          ? await controlledHook("audit", configFile, state, slot)
          : undefined;
        const result = await auditArticles({
          ...shared,
          now,
          slot,
          seriesStartDate: config.seriesStartDate,
        });
        result.archived = recovered.archived;
        if (config.controlledSync) await controlledHook("seed", configFile, state);
        const feedback = articleFeedback(state, new Date(), "audit", slot);
        const finishedAt = new Date().toISOString();
        const summary = `${synchronization ? `同步核对 ${synchronization.checked ?? 0} 篇；` : ""}格式审核完成：新稿通过 ${result.approved} 篇，修订通过 ${synchronization?.revisions ?? 0} 篇，待处理 ${feedback.issues} 项。${result.reviewed || synchronization?.revisions ? "审核通过稿件等待正式发布时点。" : "当前没有符合条件的待发布文章。"}`;
        atomicJson(path.join(home, "last-run.json"), {
          at: finishedAt,
          finishedAt,
          ...result,
          ...(synchronization ? { synchronization } : {}),
          issues: feedback.issues,
          summary,
          feedback,
        });
        console.log(JSON.stringify({ ...result, summary, feedback }));
        return;
      }
      if (action === "draft") {
        if (!config.seriesStartDate)
          throw new Error("series start date must be configured for preview");
        const result = await saveReviewDraft({
          ...shared,
          seriesStartDate: config.seriesStartDate,
          now: new Date(),
          ...(sourceRemId ? { sourceRemId } : {}),
          ...(articleId === "--new-version" ? { newVersion: true } : {}),
        });
        console.log(JSON.stringify(result));
        return;
      }
      if (action === "approve-draft") {
        const draft = state.drafts?.find(
          (item) => item.source.remId === sourceRemId && item.status === "review",
        );
        if (!draft?.draftId) throw new Error("no review draft for this source");
        const cloud = await publisher.readDraft(draft.draftId);
        if (
          cloud.state !== "draft" ||
          cloud.title !== draft.title ||
          cloud.text !== draft.text ||
          cloud.format !== draft.format ||
          cloud.authorId !== config.accountId
        )
          throw new Error("review draft changed; approval not applied");
        draft.status = "ready";
        shared.save();
        console.log(
          JSON.stringify({
            status: "draft-approved",
            draftId: draft.draftId,
            published: 0,
            moved: 0,
          }),
        );
        return;
      }
      if (action === "adopt") {
        if (!sourceRemId || !articleId)
          throw new Error("adopt requires exact source and published article IDs");
        console.log(
          JSON.stringify(await adoptPublishedArticle({ ...shared, sourceRemId, articleId })),
        );
        return;
      }
      const result = await runArticles({
        ...shared,
        now: new Date(),
        currentTime: () => new Date(),
        ...(action === "publish-now" ? { manualSourceRemId: sourceRemId as string } : {}),
        ...(config.seriesStartDate ? { seriesStartDate: config.seriesStartDate } : {}),
      });
      const finishedAt = new Date().toISOString();
      const feedback = articleFeedback(state, new Date(), "publish", publicationSlot(new Date()));
      atomicJson(path.join(home, "last-run.json"), {
        at: finishedAt,
        finishedAt,
        ...result,
        issues: feedback.issues,
        summary: feedback.issues
          ? `仍有 ${feedback.issues} 项审核问题待处理。`
          : result.published
            ? "文章已发布并完成归档核验。"
            : "本次未发布新文章。",
        feedback,
      });
      console.log(JSON.stringify(result));
      return;
    }
    const scan = await scanArticles(
      remnote,
      config.documentRemId,
      config.publishedTagRemId,
      config.aiGeneratedTagRemId,
    );
    const result: Record<string, unknown> = {
      ready: true,
      scanned: scan.nodeCount,
      pending: scan.sources.length,
      externalPending: scan.sources.filter((source) => source.tagTrigger).length,
      ...(config.publishedTagRemId
        ? { tagged: scan.taggedCount, taggedAwaitingMarker: scan.taggedAwaitingMarker }
        : {}),
      blocked: scan.blocked.length,
      published: 0,
      moved: 0,
    };
    if (action === "check") {
      const account = await publisher.check();
      if (account.id !== config.accountId)
        throw new Error("configured account does not match current login");
      result.account = { name: account.name, urlToken: account.urlToken };
      result.columnId = account.columnId;
    }
    if (action === "preview" && scan.sources[0]) {
      const source = scan.sources[0];
      const prepared = await publisher.prepare(source.nodes);
      const file = path.join(home, "preview.html");
      fs.writeFileSync(
        file,
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>知乎文章预览</title><style>body{max-width:720px;margin:40px auto;padding:0 20px;font:18px/1.8 system-ui}li{margin:8px 0}</style><h1>${prepared.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</h1>${prepared.html}</html>`,
        { mode: 0o600 },
      );
      atomicJson(path.join(home, "preview.json"), {
        sourceRemId: source.remId,
        fingerprint: source.fingerprint,
        ...prepared,
      });
      result.previewFile = file;
      result.characters = prepared.text.length;
      result.nodes = source.nodes.length;
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    if (["run", "tick", "audit", "publish-now"].includes(action)) {
      const finishedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : "";
      const reason = /^remnote_|^RemNote bridge/u.test(message)
        ? "remnote-unavailable"
        : "workflow-error";
      if (activeState) {
        activeState.reviewFailure = { at: finishedAt, issue: reviewIssue(error) };
        atomicJson(path.join(home, "state.json"), activeState);
      }
      atomicJson(path.join(home, "last-run.json"), {
        at: finishedAt,
        finishedAt,
        status: "error",
        reason,
        summary: reviewIssue(error),
        issues: Math.max(
          1,
          activeState ? articleFeedback(activeState, new Date(), "error").issues : 0,
        ),
        ...(activeState ? { feedback: articleFeedback(activeState, new Date(), "error") } : {}),
      });
    }
    throw error;
  } finally {
    await remnote.close();
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Zhihu workflow failed");
    process.exitCode = 1;
  });
