import {
  type ArticleDraft,
  type ArticlePublisher,
  type ArticleReader,
  type ArticleReceipt,
  type ArticleState,
  archiveArticle,
  mentionIdentity,
  publicationSlot,
  seriesTitle,
  validateArticle,
} from "./remnote-zhihu.js";

export interface PreparedPublicationResult {
  status: string;
  published: number;
  archived: number;
  blocked: number;
  archivePending: number;
  publications: Array<{ id: string; title: string; url: string }>;
}

/** Publishing deliberately has no RemNote reader or connection dependency. */
export async function publishPreparedArticles(options: {
  publisher: ArticlePublisher;
  accountId: string;
  columnId: string;
  state: ArticleState;
  save: () => void;
  now: Date;
  currentTime?: () => Date;
  manualSourceRemId?: string;
  seriesStartDate?: string;
}): Promise<PreparedPublicationResult> {
  const { publisher, state, save } = options;
  const publications: PreparedPublicationResult["publications"] = [];
  const verify = async (receipt: ArticleReceipt) => {
    if (!receipt.articleId) throw new Error("unknown publication result; automatic replay blocked");
    const actual = await publisher.verify(receipt.articleId);
    if (
      actual.id !== receipt.articleId ||
      actual.authorId !== options.accountId ||
      actual.title !== receipt.title ||
      actual.text !== receipt.text ||
      actual.format !== receipt.format ||
      !actual.columnIds.includes(receipt.columnId) ||
      actual.url !== `https://zhuanlan.zhihu.com/p/${receipt.articleId}`
    )
      throw new Error("published article readback mismatch");
    receipt.url = actual.url;
    receipt.stage = "verified";
    save();
    publications.push({ id: actual.id, title: actual.title, url: actual.url });
  };
  for (const receipt of state.receipts)
    if (receipt.stage === "submitting" || receipt.stage === "published") await verify(receipt);
  const result = (status: string, published = 0, blocked = 0): PreparedPublicationResult => ({
    status,
    published,
    archived: 0,
    blocked,
    archivePending: state.receipts.filter((r) => r.stage === "verified").length,
    publications,
  });
  const manual = options.manualSourceRemId;
  const slot = manual
    ? `manual:${manual}:${options.now.toISOString()}`
    : publicationSlot(options.now);
  if (!slot) return result("outside-window");
  if (!manual && state.receipts.some((r) => r.slot === slot)) return result("slot-consumed");
  const completed = new Set(state.receipts.map((r) => r.source.remId));
  if (manual && completed.has(manual)) return result("slot-consumed");
  const candidates = (state.drafts ?? []).filter(
    (d) =>
      d.status === "ready" &&
      d.draftId &&
      !completed.has(d.source.remId) &&
      (!manual || d.source.remId === manual),
  );
  const draft = candidates.find(
    (d) =>
      manual ||
      state.reviews?.some(
        (r) =>
          r.status === "approved" &&
          r.slot === slot &&
          r.sourceRemId === d.source.remId &&
          r.draftId === d.draftId &&
          r.fingerprint === d.source.fingerprint,
      ),
  );
  if (!draft) {
    if (manual) throw new Error("manual publication requires the exact approved cloud draft");
    return result(
      candidates.length
        ? "blocked"
        : (state.drafts ?? []).some((d) => ["creating", "review"].includes(d.status))
          ? "draft-review"
          : "empty",
      0,
      candidates.length,
    );
  }
  if (!publisher.readDraft) throw new Error("cloud draft readback is unavailable");
  const account = await publisher.check();
  if (account.id !== options.accountId || account.columnId !== options.columnId)
    throw new Error("publishing account or column changed");
  const cloud = await publisher.readDraft(draft.draftId as string);
  if (
    cloud.id !== draft.draftId ||
    cloud.authorId !== options.accountId ||
    cloud.title !== draft.title ||
    cloud.text !== draft.text ||
    cloud.format !== draft.format
  )
    throw new Error("cloud draft changed; author edits were preserved");
  if (cloud.state === "published") {
    const receipt: ArticleReceipt = {
      ...draft,
      slot,
      articleId: draft.draftId as string,
      columnId: options.columnId,
      stage: "published",
    };
    state.receipts.push(receipt);
    save();
    await verify(receipt);
    draft.status = "published";
    save();
    return result("published");
  }
  if (cloud.state !== "draft") throw new Error("cloud draft state changed");
  const source = draft.source;
  const prepared = await publisher.prepare(source.nodes);
  validateArticle(source, prepared, state);
  const pending = await publisher.prepare(source.nodes, "待发布");
  if (
    pending.text !== draft.text ||
    pending.format !== draft.format ||
    mentionIdentity(pending.mentionBindings) !== mentionIdentity(draft.mentionBindings) ||
    mentionIdentity(prepared.mentionBindings) !== mentionIdentity(draft.mentionBindings)
  )
    throw new Error("approved snapshot or mention identity changed");
  if (options.seriesStartDate) {
    if (!publisher.seriesStats) throw new Error("series listing is unavailable");
    prepared.title = seriesTitle(
      prepared.title,
      options.currentTime?.() ?? options.now,
      options.seriesStartDate,
      await publisher.seriesStats(),
      state,
    );
  }
  const bodyText = prepared.text;
  const firstPublishedAt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(options.currentTime?.() ?? options.now)
    .replaceAll("-", ".");
  const stamped = await publisher.prepare(source.nodes, firstPublishedAt);
  if (mentionIdentity(stamped.mentionBindings) !== mentionIdentity(draft.mentionBindings))
    throw new Error("mention identity changed before submission");
  if (!manual && publicationSlot(options.currentTime?.() ?? options.now) !== slot)
    return result("window-ended");
  const receipt: ArticleReceipt = {
    source,
    slot,
    ...prepared,
    html: stamped.html,
    text: stamped.text,
    format: stamped.format,
    bodyText,
    firstPublishedAt,
    articleId: draft.draftId as string,
    columnId: options.columnId,
    stage: "submitting",
  };
  state.receipts.push(receipt);
  save(); // Fence the original draft ID before ANY write or publish.
  const submitted = await publisher.publish(receipt.title, receipt.html, {
    ...draft,
    cloudBefore: cloud,
  } as ArticleDraft);
  if (submitted.id !== receipt.articleId)
    throw new Error("publication draft identity changed; automatic replay blocked");
  receipt.stage = "published";
  save();
  await verify(receipt);
  draft.status = "published";
  save();
  return result("published", 1);
}

/** Archive independently; failure must neither undo nor repeat a verified publication. */
export async function archivePreparedArticles(options: {
  reader: () => Promise<ArticleReader>;
  documentRemId: string;
  state: ArticleState;
  save: () => void;
}): Promise<{ archived: number; archivePending: number }> {
  const pending = options.state.receipts.filter((r) => r.stage === "verified");
  let archived = 0;
  if (pending.length) {
    try {
      const remnote = await options.reader();
      const document = await remnote.read(options.documentRemId);
      if (document.remType !== "document") throw new Error("source Document changed");
      for (const receipt of pending) {
        try {
          await archiveArticle(remnote, options.documentRemId, receipt);
          receipt.stage = "archived";
          delete receipt.archiveIssue;
          options.save();
          archived++;
        } catch {
          receipt.archiveIssue = "文章已发布；原稿归档未完成，保留原节点等待核对。";
          options.save();
        }
      }
    } catch {
      for (const receipt of pending)
        receipt.archiveIssue = "文章已发布；RemNote 连接或目标文档核验未完成，恢复后补做归档。";
      options.save();
    }
  }
  return {
    archived,
    archivePending: options.state.receipts.filter((r) => r.stage === "verified").length,
  };
}
