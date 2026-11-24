import { Link, useMatches, Outlet } from "react-router";
import { ErrorContent } from "~/components/errors";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";

export const loader = () => null;

export const meta = () => [{ title: appendToMetaTitle("Authentication") }];

export default function App() {
  const matches = useMatches();
  /** Find the title and subHeading from current route */
  const data = matches[matches.length - 1].data as {
    title?: string;
    subHeading?: string;
  };
  const { title, subHeading } = data;

  return (
    <main className="min-h-screen bg-white text-gray-950">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-6 py-10">
        <Link
          to="/"
          reloadDocument
          aria-label="IOIO Lab home"
          className="rounded-3xl focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2"
        >
          <div className="flex aspect-[316/129] w-72 max-w-full items-center justify-center overflow-hidden rounded-3xl bg-red-700 p-2 sm:w-80">
            <img
              src="/static/images/ioio-logo-white.png"
              alt="IOIO Lab"
              className="size-full object-contain"
            />
          </div>
        </Link>

        <div className="mt-9 w-full">
          <h1 className="text-center text-2xl font-bold text-gray-950">
            {title}
          </h1>
          {subHeading && (
            <p className="mt-2 text-center text-sm text-gray-500">
              {subHeading}
            </p>
          )}
          <div className="mt-7">
            <Outlet />
          </div>
        </div>
      </div>
    </main>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
