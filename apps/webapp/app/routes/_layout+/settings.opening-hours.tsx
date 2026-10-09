import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";

/** Preserve old bookmarks while keeping Opening Hours managed in Lab Info. */
export function loader(_args: LoaderFunctionArgs) {
  return redirect("/settings/lab-information#opening-hours");
}

export default function OpeningHoursRedirect() {
  return null;
}

export const handle = { breadcrumb: () => "Opening hours" };

export const meta: MetaFunction = () => [{ title: "Opening hours" }];
