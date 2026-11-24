import { IOIO_BRAND_NAME } from "~/config/ioio-brand";

/** Small helper that appends the IOIO Lab brand to the current route title. */
export const appendToMetaTitle = (title: string | null | undefined) =>
  `${title ? title : "Not found"} · ${IOIO_BRAND_NAME}`;
