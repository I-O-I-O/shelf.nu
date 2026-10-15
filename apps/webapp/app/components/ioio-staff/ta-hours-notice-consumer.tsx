import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { useLocation, useNavigate } from "react-router";
import { showNotificationAtom } from "~/atoms/notifications";

const noticeMessages: Record<string, string> = {
  budget: "TA hour budget saved.",
  allocation: "TA allocation saved.",
  shift: "Shift saved.",
  cancelled: "Shift cancelled.",
  confirmed: "Worked hours saved.",
  period:
    "Next academic-year period created with an empty budget and no allocations.",
};

export function TAHoursNoticeConsumer({
  budgetWarning,
}: {
  budgetWarning: string | null;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const showNotification = useSetAtom(showNotificationAtom);
  const consumedNoticeLocation = useRef<string | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const noticeCode = searchParams.get("notice");
    if (!noticeCode || consumedNoticeLocation.current === location.key) return;

    consumedNoticeLocation.current = location.key;
    const message = noticeMessages[noticeCode];
    if (message) {
      showNotification({
        title: "TA Hours",
        message: budgetWarning ?? message,
        icon: {
          name: "success",
          variant: budgetWarning ? "primary" : "success",
        },
        senderId: null,
      });
    }

    const cleanedParams = new URLSearchParams(searchParams);
    cleanedParams.delete("notice");
    const query = cleanedParams.toString();
    void navigate(
      `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
      {
        replace: true,
        preventScrollReset: true,
      }
    );
  }, [budgetWarning, location, navigate, showNotification]);

  return null;
}
