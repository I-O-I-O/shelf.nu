import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { handbookEditorAction } from "~/modules/ioio-handbook/editor.server";

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(`/handbook/new${url.search}`);
}

export async function action(args: ActionFunctionArgs) {
  return handbookEditorAction(args);
}
