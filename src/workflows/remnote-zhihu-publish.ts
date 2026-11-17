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
  blockingIssues?: string[];
}

/** Read-only reconciliation of a durable submission ID; never submits a publication. */
export async function recoverPreparedPublications(options: {
  publisher: ArticlePublisher;
  accountId: string;
  state: ArticleState;
  save: () => void;
}): Promise<PreparedPublicationResult["publications"]> {
  const publications: PreparedPublicationResult["publications"] = [];
  for (const receipt of options.state.receipts) {
    if (receipt.stage === "submitting" || receipt.stage === "published") {
      if (!receipt.articleId)
        throw new Error("unknown publication result; automatic replay blocked");
      const actual = await options.publisher.verify(receipt.articleId);
      if (
        actual.id !== receipt.articleId ||
        actual.authorId !== options.accountId ||
        actual.title !== receipt.title ||
        actual.text !== receipt.text ||
        actual.format !== receipt.format ||
        (receipt.tableOfContents !== undefined &&
          actual.tableOfContents !== receipt.tableOfContents) ||
        !actual.columnIds.includes(receipt.columnId) ||
        actual.url !== `https://zhuanlan.zhihu.com/p/${receipt.articleId}`
      )
        throw new Error("published article readback mismatch");
      receipt.url = actual.url;
      receipt.stage = "verified";
      options.save();
      publications.push({ id: actual.id, title: actual.title, url: actual.url });
    }
    if (receipt.stage === "verified" || receipt.stage === "archived") {
      for (const draft of options.state.drafts ?? [])
        if (
          draft.draftId === receipt.articleId &&
          draft.source.remId === receipt.source.remId &&
          draft.status !== "published"
        ) {
          draft.status = "published";
          options.save();
        }
    }
  }
  return publications;
}

export function preparedPublicationSummary(result: PreparedPublicationResult, updated = 0): string {
  const parts = [updated ? `已定时更新原文章 ${updated} 篇。` : ""];
  if (result.published) parts.push(`本次新发布 ${result.published} 篇，已完成知乎回读。`);
  else if (result.status === "blocked")
    parts.push("本次未发布新文章：待发布稿缺少本时段的有效审核记录。");
  else if (result.status === "draft-review") parts.push("本次未发布新文章：草稿仍待审核。");
  else parts.push("本次未发布新文章。");
  const recovered = Math.max(0, result.publications.length - result.published);
  if (recovered) parts.push(`已核验此前发布的 ${recovered} 篇文章。`);
  if (result.archivePending)
    parts.push(`RemNote 归档待完成 ${result.archivePending} 篇，恢复条件后补做。`);
  return parts.filter(Boolean).join("");
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
  const publications = await recoverPreparedPublications(options);
  const verify = async (receipt: ArticleReceipt) => {
    if (!receipt.articleId) throw new Error("unknown publication result; automatic replay blocked");
    publications.push(...(await recoverPreparedPublications(options)));
  };
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
      !state.syncFeedback?.articles.some(
        (r) => r.sourceRemId === d.source.remId && r.status === "blocked",
      ) &&
      !completed.has(d.source.remId) &&
      (!manual || d.source.remId === manual),
  );
  const carried = new Map<string, NonNullable<ArticleState["reviews"]>[number]>();
  for (const candidate of candidates) {
    if (manual || candidate.reviewMode !== "automatic") continue;
    const prior = state.reviews
      ?.filter(
        (r) =>
          r.status === "approved" &&
          r.sourceRemId === candidate.source.remId &&
          r.draftId === candidate.draftId &&
          r.fingerprint === candidate.source.fingerprint &&
          r.slot < slot,
      )
      .sort((a, b) => b.slot.localeCompare(a.slot))
      .find(
        (r) =>
          state.receipts.some(
            (receipt) =>
              receipt.slot === r.slot &&
              receipt.source.remId !== r.sourceRemId &&
              ["verified", "archived"].includes(receipt.stage),
          ) &&
          !state.reviews?.some(
            (later) =>
              later.sourceRemId === r.sourceRemId &&
              later.checkedAt >= r.checkedAt &&
              ["blocked", "withdrawn"].includes(later.status),
          ),
      );
    if (prior) carried.set(candidate.source.remId, prior);
  }
  const draft = candidates.find(
    (d) =>
      manual ||
      carried.has(d.source.remId) ||
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
    const blockedResult = result(
      candidates.length
        ? "blocked"
        : (state.drafts ?? []).some((d) => ["creating", "review"].includes(d.status))
          ? "draft-review"
          : "empty",
      0,
      candidates.length,
    );
    if (candidates.length)
      blockedResult.blockingIssues = candidates.map(
        (d) => `《${d.title}》缺少 ${slot} 时段的有效审核记录，已保留原草稿。`,
      );
    return blockedResult;
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
    cloud.format !== draft.format ||
    (draft.tableOfContents !== undefined && cloud.tableOfContents !== draft.tableOfContents)
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
  const pending = await publisher.prepare(source.nodes, "待发布", draft.seriesLabel);
  if (
    pending.text !== draft.text ||
    pending.format !== draft.format ||
    (draft.tableOfContents !== undefined && pending.tableOfContents !== draft.tableOfContents) ||
    mentionIdentity(pending.mentionBindings) !== mentionIdentity(draft.mentionBindings) ||
    mentionIdentity(prepared.mentionBindings) !== mentionIdentity(draft.mentionBindings)
  )
    throw new Error("approved snapshot or mention identity changed");
  let seriesLabel: string | undefined;
  if (options.seriesStartDate) {
    if (!publisher.seriesStats) throw new Error("series listing is unavailable");
    const numbered = seriesTitle(
      prepared.title,
      options.currentTime?.() ?? options.now,
      options.seriesStartDate,
      await publisher.seriesStats(),
      state,
    );
    seriesLabel = numbered.slice(numbered.lastIndexOf("（") + 1, -1);
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
  const stamped = await publisher.prepare(source.nodes, firstPublishedAt, seriesLabel);
  if (mentionIdentity(stamped.mentionBindings) !== mentionIdentity(draft.mentionBindings))
    throw new Error("mention identity changed before submission");
  if (!manual && publicationSlot(options.currentTime?.() ?? options.now) !== slot)
    return result("window-ended");
  const previousApproval = carried.get(source.remId);
  if (
    previousApproval &&
    !state.reviews?.some(
      (r) => r.sourceRemId === source.remId && r.slot === slot && r.status === "approved",
    )
  ) {
    state.reviews ??= [];
    state.reviews.push({ ...previousApproval, slot, carriedFromSlot: previousApproval.slot });
  }
  const receipt: ArticleReceipt = {
    source,
    slot,
    ...prepared,
    html: stamped.html,
    text: stamped.text,
    format: stamped.format,
    bodyText,
    firstPublishedAt,
    ...(seriesLabel ? { seriesLabel } : {}),
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
  publisher?: ArticlePublisher;
  accountId?: string;
}): Promise<{ archived: number; archivePending: number }> {
  if (options.publisher && options.accountId) {
    try {
      await recoverPreparedPublications({
        ...options,
        publisher: options.publisher,
        accountId: options.accountId,
      });
    } catch {
      /* Keep uncertain receipts fenced; unrelated draft review can continue. */
    }
  }
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
