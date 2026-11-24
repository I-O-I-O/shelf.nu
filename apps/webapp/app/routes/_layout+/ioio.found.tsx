import { redirect } from "react-router";
import { type LoaderFunctionArgs } from "react-router";
import { requireStudentRead } from "~/modules/ioio-student/route.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  await requireStudentRead({
    context,
    request,
  });
  return redirect("/ioio/report?mode=found");
}
