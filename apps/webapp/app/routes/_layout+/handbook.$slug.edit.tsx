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
import { handbookEditorAction } from "~/modules/ioio-handbook/editor.server";
import { getHandbookEditData } from "~/modules/ioio-handbook/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request, params }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioStaffAccess({ context, request });
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
    });
    if (!result.article)
      throw new ShelfError({
        cause: null,
        message: "This Handbook draft is not available.",
        label: "Handbook",
        status: 404,
        shouldBeCaptured: false,
      });
    return payload(result);
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
  const { article, assetModels, kits } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const navigation = useNavigation();
  const message =
    actionData && "message" in actionData ? actionData.message : undefined;
  return (
    <HandbookEditor
      article={article}
      assetModels={assetModels}
      kits={kits}
      busy={navigation.state === "submitting"}
      saved={new URLSearchParams(location.search).has("saved")}
      errorMessage={
        actionData && "ok" in actionData && !actionData.ok ? message : undefined
      }
    />
  );
}

export const ErrorBoundary = () => <ErrorContent />;
