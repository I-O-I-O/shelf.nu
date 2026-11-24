import { MessageCircle } from "lucide-react";
import { Link } from "react-router";

type AskRoute = "/ioio/ask" | "/staff/ask";

export type AskAboutItemButtonProps = {
  itemName: string;
  to: AskRoute;
  assetId?: string;
  kitId?: string;
  locationId?: string | null;
};

function buildAskUrl({
  itemName,
  to,
  assetId,
  kitId,
  locationId,
}: AskAboutItemButtonProps) {
  const params = new URLSearchParams({
    new: "1",
    q: `What is ${itemName}, what is it useful for, and how could I use it in a project?`,
  });

  if (assetId) params.set("assetId", assetId);
  if (kitId) params.set("kitId", kitId);
  if (locationId) params.set("locationId", locationId);

  return `${to}?${params.toString()}`;
}

export function AskAboutItemButton(props: AskAboutItemButtonProps) {
  return (
    <Link
      to={buildAskUrl(props)}
      className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 shadow-sm transition hover:border-red-300 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-200 focus:ring-offset-2 sm:w-auto"
    >
      <MessageCircle aria-hidden="true" className="size-4 shrink-0" />
      Ask IOIO about this item
    </Link>
  );
}
