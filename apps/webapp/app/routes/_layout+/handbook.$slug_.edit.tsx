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
  redirect,
} from "react-router";
import { ErrorContent } from "~/components/errors";
import { HandbookEditor } from "~/components/handbook/handbook-editor";
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { handbookEditorAction } from "~/modules/ioio-handbook/editor.server";
import {
  getHandbookEditData,
  listHandbookArticleTitles,
} from "~/modules/ioio-handbook/service.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    const revisionMode =
      new URL(request.url).searchParams.get("improve") === "1";
    if (auth.currentOrganization.type === "PERSONAL")
      throw new ShelfError({
        cause: null,
        message: "The Handbook is available in IOIO Lab workspaces only.",
        label: "Handbook",
        status: 403,
        shouldBeCaptured: false,
      });
    const result = await getHandbookEditData({
      organizationId: auth.organizationId,
      slug: params.slug,
      ownerUserId: auth.isStudent && !revisionMode ? auth.userId : undefined,
      userId: auth.userId,
      revisionMode,
    });
    if (!result.article)
      throw new ShelfError({
        cause: null,
        message: "This Handbook draft is not available.",
        label: "Handbook",
        status: 404,
        shouldBeCaptured: false,
      });
    if (revisionMode && result.article?.revisionSubmitted) {
      return redirect(
        result.article.revisionContributorUserId === auth.userId
          ? "/handbook/my-work?submitted=1"
          : `/handbook/${encodeURIComponent(params.slug ?? "")}`
      );
    }
    const titleMatches = await listHandbookArticleTitles({
      organizationId: auth.organizationId,
    });
    return payload({
      ...result,
      titleMatches,
      isStudent: auth.isStudent,
      revisionMode,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action(args: ActionFunctionArgs) {
  return handbookEditorAction({ ...args, slug: args.params.slug });
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Edit Handbook article") },
];
export const handle = { breadcrumb: () => "Edit article" };

export default function EditHandbookArticlePage() {
  const { article, categories, isStudent, revisionMode, titleMatches } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const navigation = useNavigation();
  const message =
    actionData && "message" in actionData ? actionData.message : undefined;
  return (
    <HandbookEditor
      key={article?.id ?? "missing"}
      article={article}
      categories={categories}
      isStudent={isStudent}
      titleMatches={titleMatches}
      revisionMode={revisionMode}
      busy={navigation.state === "submitting"}
      saved={new URLSearchParams(location.search).has("saved")}
      errorMessage={
        actionData && "ok" in actionData && !actionData.ok ? message : undefined
      }
    />
  );
}

export const ErrorBoundary = () => <ErrorContent />;
