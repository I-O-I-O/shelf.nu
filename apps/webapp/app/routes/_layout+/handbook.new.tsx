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
import { requireIoioHandbookRead } from "~/modules/ioio-handbook/access.server";
import { handbookRevisionAction } from "~/modules/ioio-handbook/editor-workflow.server";
import { HANDBOOK_ARTICLE_TYPES } from "~/modules/ioio-handbook/handbook.types";
import { getHandbookFormOptions } from "~/modules/ioio-handbook/workflow.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireIoioHandbookRead({ context, request });
    return payload({
      ...(await getHandbookFormOptions({
        organizationId: auth.organizationId,
        userId: auth.userId,
        canEdit: auth.canEdit,
      })),
      isStaff: auth.canEdit,
      articleTypes: HANDBOOK_ARTICLE_TYPES,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action(args: ActionFunctionArgs) {
  return handbookRevisionAction(args);
}

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("New Handbook article") },
];
export const handle = { breadcrumb: () => "New article" };

export default function NewHandbookArticlePage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <HandbookEditor
      article={null}
      revision={null}
      pendingRevision={null}
      initial={null}
      categories={data.categories}
      topics={data.topics}
      locations={data.locations}
      assetModels={data.assetModels}
      kits={data.kits}
      articleTypes={data.articleTypes}
      isStaff={data.isStaff}
      busy={navigation.state === "submitting"}
      errorMessage={
        actionData && "message" in actionData ? actionData.message : undefined
      }
    />
  );
}

export const ErrorBoundary = () => <ErrorContent />;
