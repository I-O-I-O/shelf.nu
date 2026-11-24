export type CalendarAssetMembership = {
  bookingId: string;
  quantity: number;
  asset: {
    id: string;
    title: string;
    assetModel: { id: string; name: string } | null;
    assetKits: Array<{ id: string; kit: { name: string } }>;
  };
};

/**
 * Summarize the physical/model memberships of each booking for its calendar
 * event. Memberships are inventory detail, not calendar events: rows for the
 * same product and booking are folded into one quantity-bearing label.
 */
export function summarizeBookingAssetsForCalendar(
  memberships: CalendarAssetMembership[]
): Map<string, string[]> {
  const quantitiesByBooking = new Map<
    string,
    Map<string, { name: string; quantity: number }>
  >();

  for (const membership of memberships) {
    const kit = membership.asset.assetKits[0];
    const model = membership.asset.assetModel;
    const name = kit?.kit.name ?? model?.name ?? membership.asset.title;
    const productId = kit
      ? `kit:${kit.id}`
      : model
      ? `model:${model.id}`
      : `asset:${membership.asset.id}`;
    const products = quantitiesByBooking.get(membership.bookingId) ?? new Map();
    const current = products.get(productId);

    products.set(productId, {
      name,
      quantity: (current?.quantity ?? 0) + membership.quantity,
    });
    quantitiesByBooking.set(membership.bookingId, products);
  }

  return new Map(
    [...quantitiesByBooking].map(([bookingId, products]) => [
      bookingId,
      [...products.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, quantity }) =>
          quantity > 1 ? `${name} ×${quantity}` : name
        ),
    ])
  );
}
