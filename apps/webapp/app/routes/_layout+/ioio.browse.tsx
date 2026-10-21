import { Outlet, redirect } from "react-router";
import { type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { ErrorContent } from "~/components/errors";
import { requireStudentRead } from "~/modules/ioio-student/route.server";

export const meta: MetaFunction = () => [
  { title: "Browse equipment | IOIO Lab" },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  await requireStudentRead({ context, request });

  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/u, "") === "/ioio/browse") {
    return redirect(`/ioio${url.search}`);
  }

  // Keep the existing /ioio/browse/:assetId detail route working. The catalog
  // itself now lives on Home, so the parent only renders the nested detail.
  return null;
}

export const ErrorBoundary = () => <ErrorContent />;

export default function IoioBrowseLayout() {
  return <Outlet />;
}
