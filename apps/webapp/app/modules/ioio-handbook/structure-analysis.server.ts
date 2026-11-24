import { z } from "zod";
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL,
} from "~/utils/env";
import type {
  HandbookImportArticle,
  HandbookImportDraft,
} from "./pdf-import.shared";

const responseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

const suggestionSchema = z.object({
  categorySuggestion: z.string().trim().max(80),
  articles: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(180),
        sourceSections: z.array(z.string().min(1)),
        proposedOutline: z.array(z.string().trim().min(1).max(180)),
        rationale: z.string().trim().min(1).max(600),
      })
    )
    .min(1)
    .max(30),
});

export class HandbookStructureAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandbookStructureAnalysisError";
  }
}

export function isHandbookStructureAnalysisAvailable() {
  return Boolean(ANTHROPIC_API_KEY);
}

/** Claude receives only the extracted heading tree, section text, and source
 * order. It returns organization suggestions; original Markdown remains the
 * only article content and each source section must be represented once. */
export async function improveHandbookStructureWithClaude(
  draft: HandbookImportDraft
) {
  if (!ANTHROPIC_API_KEY) {
    throw new HandbookStructureAnalysisError(
      "Claude structure analysis is not configured."
    );
  }
  const sourceSectionIds = new Set(draft.sections.map(({ id }) => id));
  if (!sourceSectionIds.size) {
    throw new HandbookStructureAnalysisError(
      "This PDF has no extracted sections for Claude to organize."
    );
  }
  const requestData = {
    sections: draft.sections.map((section, sourceOrder) => ({
      id: section.id,
      title: section.title,
      hierarchyLevel: section.level,
      sourceOrder,
      text: section.markdown,
    })),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const response = await fetch(ANTHROPIC_BASE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 3500,
        system: [
          "Organize extracted Handbook source sections into coherent articles.",
          "Return only JSON with categorySuggestion and articles containing title, sourceSections, proposedOutline, rationale.",
          "sourceSections must contain source section IDs from the input, and every ID must appear exactly once across all articles.",
          "Do not write, summarize, rewrite, omit, or invent source content. Preserve source order within each article.",
          "Split by coherent knowledge tasks, not by page boundaries.",
        ].join(" "),
        messages: [{ role: "user", content: JSON.stringify(requestData) }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HandbookStructureAnalysisError(
        "Claude could not improve the structure. The deterministic proposal is still available."
      );
    }
    const parsedResponse = responseSchema.safeParse(await response.json());
    if (!parsedResponse.success) {
      throw new HandbookStructureAnalysisError(
        "Claude returned an unreadable structure proposal. The deterministic proposal is still available."
      );
    }
    const text = parsedResponse.data.content.find(
      (block) => block.type === "text" && block.text
    )?.text;
    if (!text) {
      throw new HandbookStructureAnalysisError(
        "Claude returned an empty structure proposal. The deterministic proposal is still available."
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new HandbookStructureAnalysisError(
        "Claude returned an unreadable structure proposal. The deterministic proposal is still available."
      );
    }
    const suggestion = suggestionSchema.safeParse(decoded);
    if (!suggestion.success) {
      throw new HandbookStructureAnalysisError(
        "Claude returned an invalid structure proposal. The deterministic proposal is still available."
      );
    }
    const representedIds = suggestion.data.articles.flatMap(
      ({ sourceSections }) => sourceSections
    );
    const exactCoverage =
      representedIds.length === sourceSectionIds.size &&
      new Set(representedIds).size === representedIds.length &&
      representedIds.every((id) => sourceSectionIds.has(id));
    if (!exactCoverage) {
      throw new HandbookStructureAnalysisError(
        "Claude did not preserve every source section exactly once. The deterministic proposal is still available."
      );
    }

    const order = new Map(draft.sections.map(({ id }, index) => [id, index]));
    const articles: HandbookImportArticle[] = suggestion.data.articles.map(
      (article, index) => {
        const sectionIds = [...article.sourceSections].sort(
          (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0)
        );
        return {
          id: `claude-article-${index + 1}`,
          title: article.title,
          sections: sectionIds.map(
            (id) => draft.sections.find((section) => section.id === id)!
          ),
          proposedOutline: article.proposedOutline,
          rationale: article.rationale,
        };
      }
    );
    return {
      categorySuggestion: suggestion.data.categorySuggestion,
      articles,
    };
  } catch (cause) {
    if (cause instanceof HandbookStructureAnalysisError) throw cause;
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new HandbookStructureAnalysisError(
        "Claude timed out. The deterministic proposal is still available."
      );
    }
    throw new HandbookStructureAnalysisError(
      "Claude is unavailable. The deterministic proposal is still available."
    );
  } finally {
    clearTimeout(timeout);
  }
}
