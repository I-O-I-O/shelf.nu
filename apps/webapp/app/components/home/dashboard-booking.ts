import type { UserNameFields } from "~/utils/user";

export type DashboardBooking = {
  id: string;
  name: string;
  from: Date | string;
  to: Date | string;
  custodianTeamMember?: { name: string } | null;
  custodianUser?: UserNameFields | null;
  _count?: { bookingAssets?: number };
};
