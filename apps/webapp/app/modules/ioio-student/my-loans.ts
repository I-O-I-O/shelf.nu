export type PendingStudentReturnReference = {
  bookingId: string | null;
  bookingAssetId: string | null;
};

export function splitStudentLoanSections<
  TLoan extends {
    id: string;
    status?: string;
    from?: Date | string;
    bookingAssets: TAsset[];
  },
  TAsset extends {
    id: string;
    returnedAt?: Date | string | null;
    checkedOutAt?: Date | string | null;
  },
>(loans: TLoan[], pendingReturns: PendingStudentReturnReference[]) {
  const pendingKeys = new Set(
    pendingReturns
      .filter(
        (
          reference
        ): reference is {
          bookingId: string;
          bookingAssetId: string;
        } => Boolean(reference.bookingId && reference.bookingAssetId)
      )
      .map((reference) => `${reference.bookingId}:${reference.bookingAssetId}`)
  );
  const isPending = (bookingId: string, bookingAssetId: string) =>
    pendingKeys.has(`${bookingId}:${bookingAssetId}`);

  const timestamp = (value: Date | string | null | undefined) =>
    value ? new Date(value).getTime() || 0 : 0;
  const pastLoans = loans
    .filter((loan) => loan.status === "COMPLETE")
    .sort((left, right) => {
      const returned = (loan: TLoan) =>
        Math.max(
          0,
          ...loan.bookingAssets.map((asset) => timestamp(asset.returnedAt))
        );
      const checkedOut = (loan: TLoan) =>
        Math.max(
          0,
          ...loan.bookingAssets.map((asset) => timestamp(asset.checkedOutAt))
        );
      return (
        returned(right) - returned(left) ||
        checkedOut(right) - checkedOut(left) ||
        timestamp(right.from) - timestamp(left.from) ||
        right.id.localeCompare(left.id)
      );
    });
  const currentLoans = loans.filter((loan) => loan.status !== "COMPLETE");
  const activeLoans = currentLoans
    .map((loan) => ({
      ...loan,
      bookingAssets: loan.bookingAssets.filter(
        (bookingAsset) => !isPending(loan.id, bookingAsset.id)
      ),
    }))
    .filter((loan) => loan.bookingAssets.length > 0);
  const pendingLoanGroups = currentLoans
    .map((loan) => ({
      ...loan,
      bookingAssets: loan.bookingAssets.filter((bookingAsset) =>
        isPending(loan.id, bookingAsset.id)
      ),
    }))
    .filter((loan) => loan.bookingAssets.length > 0);

  return { activeLoans, pendingLoanGroups, pastLoans, isPending };
}
