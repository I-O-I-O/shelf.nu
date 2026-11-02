import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
} from "react-router";
import { ErrorContent } from "~/components/errors";
import { HandbookEditor } from "~/components/handbook/handbook-editor";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { handbookRevisionAction } from "~/modules/ioio-handbook/editor-workflow.server";
import { HANDBOOK_ARTICLE_TYPES } from "~/modules/ioio-handbook/handbook.types";
import {
  HandbookWorkflowError,
  getHandbookFormOptions,
} from "~/modules/ioio-handbook/workflow.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    const revisionId =
      new URL(request.url).searchParams.get("revision") ?? undefined;
    const result = await getHandbookFormOptions({
      organizationId: auth.organizationId,
      userId: auth.userId,
      canEdit: auth.canEdit,
      slug: params.slug,
      revisionId,
    });
    if (result.article?.status === "ARCHIVED")
      throw new ShelfError({
        cause: null,
        message: "Archived articles cannot be edited.",
        label: "Handbook",
        status: 404,
        shouldBeCaptured: false,
      });
    return payload({
      ...result,
      isStaff: auth.canEdit,
      articleTypes: HANDBOOK_ARTICLE_TYPES,
    });
  } catch (cause) {
    if (cause instanceof HandbookWorkflowError) {
      throw new ShelfError({
        cause,
        message: cause.message,
        label: "Handbook",
        status: cause.status,
        shouldBeCaptured: false,
      });
    }
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action(args: ActionFunctionArgs) {
  return handbookRevisionAction({ ...args, slug: args.params.slug });
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Edit Handbook article") },
];
export const handle = { breadcrumb: () => "Edit article" };

export default function EditHandbookArticlePage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const navigation = useNavigation();
  return (
    <HandbookEditor
      article={data.article}
      revision={
        data.revision
          ? {
              id: data.revision.id,
              revisionNumber: data.revision.revisionNumber,
            }
          : null
      }
      pendingRevision={data.pendingRevision}
      initial={data.initial}
      categories={data.categories}
      topics={data.topics}
      locations={data.locations}
      assetModels={data.assetModels}
      kits={data.kits}
      articleTypes={data.articleTypes}
      isStaff={data.isStaff}
      busy={navigation.state === "submitting"}
      saved={new URLSearchParams(location.search).has("saved")}
      errorMessage={
        actionData && "message" in actionData ? actionData.message : undefined
      }
    />
  );
}

export const ErrorBoundary = () => <ErrorContent />;
