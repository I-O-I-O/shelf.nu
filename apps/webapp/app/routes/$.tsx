import { useLocation } from "react-router";
import {
  BackToIoioButton,
  IOIO_ERROR_COPY,
  IoioErrorScreen,
} from "~/components/errors";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";

export const meta = () => [{ title: appendToMetaTitle("Page not found") }];

export default function LayoutSplat() {
  const location = useLocation();
  const backTo = location.pathname.startsWith("/ioio") ? "/ioio" : "/home";

  return (
    <IoioErrorScreen
      title="Page not found"
      message={IOIO_ERROR_COPY.notFound}
      actions={<BackToIoioButton to={backTo} />}
    />
  );
}
