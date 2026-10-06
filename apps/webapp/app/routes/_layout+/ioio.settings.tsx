import type { Prisma } from "@prisma/client";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, Outlet, useLoaderData, useLocation } from "react-router";
import { Card } from "~/components/shared/card";
import { requireStudentAccountSettings } from "~/modules/ioio-student/route.server";
import { getUserByID } from "~/modules/user/service.server";
import { payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireStudentAccountSettings({ context, request });
  const user = await getUserByID(auth.userId, {
    select: { email: true, firstName: true, lastName: true },
  } satisfies { select: Prisma.UserSelect });
  return payload({
    profile: {
      email: user.email,
      name:
        [user.firstName, user.lastName].filter(Boolean).join(" ") || "Student",
    },
  });
}

export const meta: MetaFunction = () => [{ title: "Student settings" }];

const settingsLinks = [
  { to: "/ioio/settings", label: "Profile", end: true },
  {
    to: "/ioio/settings/email-preferences",
    label: "Email preferences",
    end: false,
  },
  { to: "/ioio/settings/account", label: "Account", end: false },
  {
    to: "/ioio/settings/access-approval",
    label: "Access approval",
    end: false,
  },
];

export default function IoioStudentSettings() {
  const { profile } = useLoaderData<typeof loader>();
  const location = useLocation();
  const isIndex = location.pathname === "/ioio/settings";

  return (
    <section className="max-w-4xl space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
          Student account
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-gray-950">
          Settings
        </h1>
      </div>

      <nav
        aria-label="Student settings"
        className="flex flex-wrap gap-2 border-b border-gray-200 pb-3"
      >
        {settingsLinks.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={`rounded-xl px-3 py-2 text-sm font-bold transition focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 ${
              (item.end ? isIndex : location.pathname.startsWith(item.to))
                ? "bg-red-700 text-white"
                : "text-gray-700 hover:bg-red-50 hover:text-red-800"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {isIndex ? (
        <Card className="my-0 space-y-4 rounded-2xl p-5 shadow-sm">
          <div>
            <h2 className="text-lg font-black text-gray-950">Profile</h2>
            <p className="mt-1 text-sm text-gray-600">
              Your name and email used for IOIO Lab borrowing and messages.
            </p>
          </div>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Name
              </dt>
              <dd className="mt-1 text-sm font-semibold text-gray-950">
                {profile.name}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-gray-500">
                Email
              </dt>
              <dd className="mt-1 break-words text-sm font-semibold text-gray-950">
                {profile.email}
              </dd>
            </div>
          </dl>
        </Card>
      ) : (
        <Outlet />
      )}
    </section>
  );
}
