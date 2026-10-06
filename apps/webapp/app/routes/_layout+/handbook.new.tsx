import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  useActionData,
  useLoaderData,
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

export async function loader({ context, request }: LoaderFunctionArgs) {
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
    return payload(
      await getHandbookEditData({ organizationId: auth.organizationId })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action(args: ActionFunctionArgs) {
  return handbookEditorAction(args);
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("New Handbook article") },
];
export const handle = { breadcrumb: () => "New article" };

export default function NewHandbookArticlePage() {
  const { article, assetModels, kits } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const message =
    actionData && "message" in actionData ? actionData.message : undefined;
  return (
    <HandbookEditor
      article={article}
      assetModels={assetModels}
      kits={kits}
      busy={navigation.state === "submitting"}
      errorMessage={
        actionData && "ok" in actionData && !actionData.ok ? message : undefined
      }
    />
  );
}

export const ErrorBoundary = () => <ErrorContent />;
