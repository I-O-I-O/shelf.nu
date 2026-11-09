/**
 * Repair the six local Laser Cutter Guide articles entered through AX setValue.
 * It bypassed handlePaste, inserting Markdown as text with hard breaks. The
 * serializer escaped those breaks. Supply Markdown directly to Handbook services
 * with actual newlines instead of setting a rich editor's accessibility value.
 * Dry run by default; --apply publishes new revisions and retains history.
 */
import { db } from "../../app/database/db.server";
import {
  saveHandbookDraft,
  publishHandbookArticle,
} from "../../app/modules/ioio-handbook/service.server";
const ids = [
  "cmw9fa4xh0003xm028vz7eqri",
  "cmw9fbnrr000jxm02fbmzmggk",
  "cmw9fccrj000txm02hpi8ahbi",
  "cmw9fd3fj0019xm02rxxbkfdp",
  "cmw9fdpng001rxm02xaymckx9",
  "cmw9fea2y0027xm02rp5s9jcu",
];
async function main() {
  if (
    !["localhost", "127.0.0.1", "::1"].includes(
      new URL(process.env.DATABASE_URL!).hostname
    )
  )
    throw new Error("Local development database required");
  const articles = await db.handbookArticle.findMany({
    where: { id: { in: ids }, handbookCategory: { name: "Laser Cutting" } },
    include: { publishedVersion: true },
    orderBy: { position: "asc" },
  });
  if (articles.length !== 6) throw new Error("Expected six migration articles");
  const repairs = articles.map((article) => {
    const version = article.publishedVersion;
    if (!version || article.draftContent !== version.content)
      throw new Error(`Unpublished changes: ${article.slug}`);
    // Only this migration's confirmed backslash + CRLF artifacts are repaired.
    // Abort for other backslashes rather than altering code or path syntax.
    const content = version.content.replace(/\\\r\n/g, "\n");
    if (content.includes("\\"))
      throw new Error(`Review backslashes: ${article.slug}`);
    return { article, content };
  });
  for (const { article, content } of repairs) {
    if (content === article.publishedVersion!.content) {
      console.log(`Already clean: ${article.slug}`);
      continue;
    }
    console.log(`Repair: ${article.slug}`);
    if (!process.argv.includes("--apply")) continue;
    await saveHandbookDraft({
      organizationId: article.organizationId,
      userId: article.updatedByUserId,
      articleId: article.id,
      title: article.draftTitle,
      handbookCategoryId: article.handbookCategoryId!,
      content,
      sourceUrls: article.draftSourceUrls,
    });
    await publishHandbookArticle({
      organizationId: article.organizationId,
      userId: article.updatedByUserId,
      articleId: article.id,
    });
    const after = await db.handbookArticle.findUniqueOrThrow({
      where: { id: article.id },
      include: { publishedVersion: true },
    });
    if (
      after.publishedVersion?.content !== content ||
      after.position !== article.position ||
      after.staffOnly !== article.staffOnly ||
      after.slug !== article.slug ||
      after.handbookCategoryId !== article.handbookCategoryId
    )
      throw new Error(`Verification failed: ${article.slug}`);
  }
}
main().finally(() => db.$disconnect());
