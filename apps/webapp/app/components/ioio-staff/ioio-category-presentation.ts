const IOIO_CATEGORY_COLOR_FALLBACK = "#827717";

export function getIoioCategoryColor(_name: string | null | undefined): string {
  // Callers should prefer Category.color. This is only for legacy records or
  // synthetic filters that do not have a Category row available.
  return IOIO_CATEGORY_COLOR_FALLBACK;
}
