import { Link, useLoaderData } from "react-router";
import { data, type LoaderFunctionArgs } from "react-router";
import {
  formatStudentLabel,
  SectionHeading,
} from "~/components/ioio-student/student-ui";
import KitImage from "~/components/kits/kit-image";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { getStudentKits } from "~/modules/ioio-student/service.server";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId, organizationId } = await requireStudentRead({
    context,
    request,
  });
  try {
    return data(payload({ kits: await getStudentKits({ organizationId }) }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export default function IoioKits() {
  const { kits } = useLoaderData<typeof loader>();
  return (
    <div>
      <SectionHeading
        title="Kits"
        text="Shelf kits and their member assets, shown without edit controls."
      />
      {kits.length ? (
        <div className="space-y-3">
          {kits.map((kit) => (
            <article
              key={kit.id}
              className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <KitImage
                    kit={{
                      kitId: kit.id,
                      image: kit.image,
                      imageExpiration: kit.imageExpiration,
                      alt: kit.name,
                    }}
                    alt={kit.name}
                    className="size-16 shrink-0 rounded-lg border border-gray-200 object-cover"
                  />
                  <div className="min-w-0">
                    <h2 className="font-semibold">
                      {formatStudentLabel(kit.name)}
                    </h2>
                    <p className="mt-1 text-xs text-gray-600">
                      {kit.status.replaceAll("_", " ")}
                    </p>
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                    kit.availableToBook
                      ? "bg-green-100 text-green-800"
                      : "bg-gray-100 text-gray-700"
                  }`}
                >
                  {kit.availableToBook ? "Available" : "Unavailable"}
                </span>
              </div>
              <p className="mt-2 text-sm text-gray-600">
                Location:{" "}
                {kit.location
                  ? formatStudentLabel(kit.location.name)
                  : "Not placed"}
              </p>
              <ul className="mt-3 space-y-1 text-sm text-gray-700">
                {kit.assetKits.map((member) => (
                  <li key={member.asset.id}>
                    <Link
                      to={`/ioio/browse/${member.asset.id}`}
                      className="font-medium text-red-700 hover:underline"
                    >
                      {formatStudentLabel(member.asset.title)}
                    </Link>
                    {member.quantity > 1 ? ` · ${member.quantity} units` : ""}
                  </li>
                ))}
              </ul>
              {kit.qrCodes.length ? (
                <p className="mt-3 text-sm">
                  <Link
                    to={`/qr/${kit.qrCodes[0].id}`}
                    className="font-medium text-red-700 hover:underline"
                  >
                    Open kit QR
                  </Link>
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
          No kits yet.
        </div>
      )}
    </div>
  );
}
