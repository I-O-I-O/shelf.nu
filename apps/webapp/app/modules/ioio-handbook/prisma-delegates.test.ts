import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("generated Handbook Prisma client", () => {
  it("exposes delegates required by Handbook reads and reviews", async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: "postgresql://localhost:5432/handbook-test" } },
    });

    try {
      for (const delegate of [
        prisma.handbookArticle,
        prisma.handbookArticleVersion,
        prisma.handbookRevision,
        prisma.handbookFinding,
        prisma.handbookCategory,
        prisma.handbookTopic,
      ]) {
        expect(typeof delegate.count).toBe("function");
      }
    } finally {
      await prisma.$disconnect();
    }
  });
});
