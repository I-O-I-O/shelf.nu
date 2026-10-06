export type PendingStudentReturnReference = {
  bookingId: string | null;
  bookingAssetId: string | null;
};

export function splitStudentLoanSections<
  TLoan extends { id: string; status?: string; bookingAssets: TAsset[] },
  TAsset extends { id: string },
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

  const pastLoans = loans.filter((loan) => loan.status === "COMPLETE");
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
