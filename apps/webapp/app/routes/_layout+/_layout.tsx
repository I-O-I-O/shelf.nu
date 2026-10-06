import type { Prisma } from "@prisma/client";
import { OrganizationRoles, Roles } from "@prisma/client";
import { useAtom } from "jotai";
import type {
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  redirect,
  Outlet,
  useLocation,
  useLoaderData,
} from "react-router";
import { useHydrated } from "remix-utils/use-hydrated";
import { AtomsResetHandler } from "~/atoms/atoms-reset-handler";
import { feedbackModalOpenAtom } from "~/atoms/feedback";
import { ErrorContent } from "~/components/errors";

import FeedbackModal from "~/components/feedback/feedback-modal";
import StaffShell from "~/components/ioio-staff/staff-shell";
import { CommandPaletteRoot } from "~/components/layout/command-palette";
import {
  SidebarInset,
  SidebarProvider,
} from "~/components/layout/sidebar/sidebar";
import { SkipLinks } from "~/components/layout/skip-links";
import { useCrisp } from "~/components/marketing/crisp";
import { SequentialIdMigrationModal } from "~/components/sequential-id-migration-modal";
import { Spinner } from "~/components/shared/spinner";
import { Toaster } from "~/components/shared/toast";
import { MissingPaymentMethodBanner } from "~/components/subscription/missing-payment-method-banner";
import { NoSubscription } from "~/components/subscription/no-subscription";
import { UnpaidInvoiceBanner } from "~/components/subscription/unpaid-invoice-banner";
import { config } from "~/config/shelf.config";
import { db } from "~/database/db.server";
import { revokeAllSessions } from "~/modules/auth/service.server";
import { getLegacyLoginDecisionForUser } from "~/modules/auth/sso-enforcement.server";
import { getBookingSettingsForOrganization } from "~/modules/booking-settings/service.server";
import { getLabStatus } from "~/modules/ioio-staff/lab-status.server";
import { getAssignedOpenLabTaskCount } from "~/modules/ioio-staff/lab-tasks.server";
import { getStudentAnnualAccessApproval } from "~/modules/ioio-student/annual-access.server";
import { isStudentLabIntroductionRequired } from "~/modules/ioio-student/lab-introduction.shared";
import {
  logIoioStudentLoadFailure,
  logIoioStudentLoadStage,
  withIoioStudentLoadStage,
} from "~/modules/ioio-student/load-diagnostics.server";
import { getStudentIoioNotifications } from "~/modules/ioio-student/notifications.server";
import {
  getSelectedOrganization,
  setSelectedOrganizationIdCookie,
} from "~/modules/organization/context.server";
import { getUnreadCountForUser } from "~/modules/update/service.server";
import { getUserByID } from "~/modules/user/service.server";
import { getWorkingHoursForOrganization } from "~/modules/working-hours/service.server";
import ioioStaffStyles from "~/styles/ioio-staff.css?url";
import styles from "~/styles/layout/index.css?url";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import {
  expireHostOnlyUserPrefsCookie,
  initializePerPageCookieOnLayout,
  setCookie,
  userPrefs,
} from "~/utils/cookies.server";
import { isLikeShelfError, makeShelfError, ShelfError } from "~/utils/error";
import { isRouteError } from "~/utils/http";
import { payload, error } from "~/utils/http.server";
import {
  isIoioStaffRoute,
  resolveIoioAccountSurface,
} from "~/utils/ioio-role-routing";
import { skipRevalidationOnClientViewChange } from "~/utils/list-view-params";
import type { CustomerWithSubscriptions } from "~/utils/stripe.server";

import {
  disabledTeamOrg,
  getCustomerActiveSubscription,
  getStripeCustomer,
  stripe,
  validateSubscriptionIsActive,
} from "~/utils/stripe.server";
import { canUseAudits, canUseBookings } from "~/utils/subscription.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: styles },
  { rel: "stylesheet", href: ioioStaffStyles },
];

export type LayoutLoaderResponse = typeof loader;

/**
 * The app-shell loader (user, org, subscription) does not depend on a page's
 * client-side view params (search/sort/page). Skip re-running it for same-path
 * client-view-only navigations so pages that filter client-side (e.g. the
 * booking overview) never trigger a shell refetch. Mutations and real
 * navigations still revalidate.
 */
export const shouldRevalidate = skipRevalidationOnClientViewChange;

/**
 * Gate for every authenticated route beneath this layout, and the source of the
 * data its chrome renders.
 *
 * The gates run in a fixed order and the order is load-bearing: the SSO
 * sign-in policy, then subscription validity, then onboarding, then
 * organization resolution. Onboarding has to clear before org resolution
 * because `getSelectedOrganization` throws for a user with no membership,
 * which is exactly the state a non-onboarded user is in: resolving first turns
 * "finish signing up" into an error page.
 *
 * Because the gate covers routes at every depth, its redirects are absolute. A
 * relative target resolves against the URL the user arrived at, so anyone
 * following a QR or email link into a nested route would be sent somewhere
 * that does not exist.
 *
 * @param args.context - Carries the auth session the gates run against
 * @param args.request - Read for the per-page cookie and the current URL
 * @returns The user, their organizations, subscription state and layout prefs
 * @throws {Response} A redirect to `/onboarding` for a user who has not
 *   finished signing up, or an error response when a gate refuses. A user
 *   whose address must now sign in with SSO has every session revoked, is
 *   signed out and redirected to `/login?sso_required=true` (returned, not
 *   thrown).
 */
export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;
  const pathname = new URL(request.url).pathname;
  const isStudentIoioRequestPath =
    pathname === "/ioio" || pathname.startsWith("/ioio/");
  logIoioStudentLoadStage(
    "0 shared authenticated-layout loader entered",
    "STARTED",
    isStudentIoioRequestPath
  );

  try {
    // Run user fetch and cookie parsing in parallel — these are independent
    // and safe to run before the onboarding guard.
    // NOTE: getSelectedOrganization is intentionally NOT included here.
    // It can throw when a user has no org membership, and the onboarding
    // guard (user.onboarded check) must run first to redirect non-onboarded
    // users before org resolution is attempted.
    const [user, userPrefsCookie] = await Promise.all([
      withIoioStudentLoadStage(
        "1 authenticated user/profile query",
        isStudentIoioRequestPath,
        () =>
          getUserByID(userId, {
            select: {
              id: true,
              email: true,
              username: true,
              firstName: true,
              lastName: true,
              displayName: true,
              profilePicture: true,
              onboarded: true,
              customerId: true,
              skipSubscriptionCheck: true,
              sso: true,
              tierId: true,
              hasUnpaidInvoice: true,
              warnForNoPaymentMethod: true,
              roles: { select: { id: true, name: true } },
              userOrganizations: {
                where: {
                  userId: authSession.userId,
                },
                select: {
                  id: true,
                  roles: true,
                  labIntroductionCompleted: true,
                  organization: { select: { id: true } },
                  user: { select: { id: true } },
                },
              },
            } satisfies Prisma.UserSelect,
          })
      ),
      initializePerPageCookieOnLayout(request),
    ]);

    // A session opened through a legacy path (password, OTP) outlives the
    // decision that now refuses that path, e.g. once the user's domain is
    // configured for SSO. End it, so the refusal applies to sessions already
    // open and not only to new sign-ins. SSO users are never refused here: their
    // session came from SSO.
    // Every session of the account is revoked server-side, not only this
    // cookie: the refresh-token row is the auth boundary, so a session left
    // open in another browser would otherwise keep refreshing.
    if (!user.sso) {
      const decision = await getLegacyLoginDecisionForUser({
        userId: user.id,
        email: user.email,
      });
      if (!decision.allowed) {
        await revokeAllSessions(authSession.accessToken);
        context.destroySession();
        return redirect("/login?sso_required=true");
      }
    }

    let subscription = null;

    if (user.customerId && stripe) {
      const customer = (await getStripeCustomer(
        user.customerId
      )) as CustomerWithSubscriptions;
      subscription = getCustomerActiveSubscription({ customer });
      await validateSubscriptionIsActive({ user, customer });
    }

    if (!user.onboarded) {
      // Absolute: a relative target resolves against the URL the user arrived
      // at, so anyone landing deeper than the root — a QR link, a link from an
      // email — is sent to `<their/path>/onboarding`, which does not exist.
      return redirect("/onboarding");
    }

    // Org resolution runs after the onboarding guard — safe now since
    // we know the user is onboarded and should have org membership.
    const {
      organizationId,
      organizations,
      currentOrganization,
      cookieRefreshNeeded,
      noVisibleOrganizations,
    } = await withIoioStudentLoadStage(
      "1 organization membership lookup",
      isStudentIoioRequestPath,
      () =>
        getSelectedOrganization({
          userId: authSession.userId,
          request,
        })
    );

    // SSO user with no team orgs — redirect to a friendly pending page
    if (noVisibleOrganizations) {
      return redirect("/sso-pending-assignment");
    }

    const isAdmin = user?.roles.some((role) => role.name === Roles["ADMIN"]);

    // Get current user's organization role for updates filtering
    const currentOrganizationMembership = user?.userOrganizations.find(
      (userOrg) => userOrg.organization.id === organizationId
    );
    const currentOrganizationUserRoles = currentOrganizationMembership?.roles;

    if (
      !currentOrganizationMembership ||
      !currentOrganizationUserRoles?.length
    ) {
      throw new ShelfError({
        cause: null,
        title: "Organization access required",
        message:
          "Your account is not assigned to this organization. Please contact Staff.",
        status: 403,
        label: "Permission",
        shouldBeCaptured: false,
        additionalData: { userId: authSession.userId, organizationId },
      });
    }

    // Check if current user has OWNER or ADMIN role in the organization
    const isOwner = currentOrganizationUserRoles?.includes("OWNER");
    const isOrgAdmin = currentOrganizationUserRoles?.includes("ADMIN");
    const isIoioStaff = Boolean(isOwner || isOrgAdmin);
    const isStudentIoioRequest =
      isStudentIoioRequestPath &&
      !isIoioStaff &&
      currentOrganizationUserRoles.includes(OrganizationRoles.SELF_SERVICE);
    logIoioStudentLoadStage("1 auth/membership", "OK", isStudentIoioRequest);
    const accountSurface = resolveIoioAccountSurface(
      currentOrganizationUserRoles
    );
    if (!accountSurface) {
      throw new ShelfError({
        cause: null,
        title: "Account role could not be resolved",
        message:
          "Your IOIO account role could not be verified. Please contact Staff.",
        status: 403,
        label: "Permission",
        shouldBeCaptured: false,
      });
    }
    if (
      accountSurface === "staff" &&
      (pathname === "/ioio" || pathname.startsWith("/ioio/"))
    ) {
      return redirect("/home");
    }
    const isLabToolsRoute =
      pathname === "/operations/tasks" ||
      pathname === "/purchasing" ||
      pathname === "/ta-hours";
    // Keep TA membership stable across client-side navigation. The shared
    // layout uses this value to decide whether a SELF_SERVICE user may render
    // Lab Tools routes, so it must not depend on which route loaded first.
    const isIoioTA = Boolean(
      await withIoioStudentLoadStage(
        "5 TA membership query (ioioLabTA.findUnique)",
        isStudentIoioRequest,
        () =>
          db.ioioLabTA.findUnique({
            where: {
              organizationId_userId: {
                organizationId: currentOrganization.id,
                userId: authSession.userId,
              },
            },
            select: { id: true },
          })
      )
    );

    const isStudentOnly =
      currentOrganizationUserRoles.includes(OrganizationRoles.SELF_SERVICE) &&
      !isIoioStaff;
    const isLabIntroductionRoute = pathname === "/ioio/introduction";
    const needsLabIntroduction = isStudentLabIntroductionRequired({
      roles: currentOrganizationUserRoles,
      completed: currentOrganizationMembership.labIntroductionCompleted,
    });
    if (needsLabIntroduction && !isLabIntroductionRoute) {
      return redirect("/ioio/introduction");
    }
    if (
      isLabIntroductionRoute &&
      currentOrganizationMembership.labIntroductionCompleted
    ) {
      return redirect("/ioio");
    }
    if (
      isStudentOnly &&
      isIoioStaffRoute(pathname) &&
      !(isLabToolsRoute && isIoioTA)
    ) {
      return redirect("/ioio");
    }

    // Check if sequential ID migration is needed
    const needsSequentialIdMigration =
      (isOwner || isOrgAdmin) && !currentOrganization.hasSequentialIdsMigrated;

    if (!organizations.length || !currentOrganization) {
      throw new ShelfError({
        cause: null,
        title: "No organization",
        message:
          "You are not part of any organization. Please contact support.",
        status: 403,
        label: "Organization",
      });
    }

    // Run booking settings, working hours, and unread count in parallel —
    // all only depend on organizationId/userId which are available now.
    const [
      bookingSettings,
      workingHours,
      unreadUpdatesCount,
      labStatus,
      assignedLabTaskCount,
      annualAccessApproval,
    ] = await Promise.all([
      withIoioStudentLoadStage(
        "5 shared shell query (booking settings)",
        isStudentIoioRequest,
        () => getBookingSettingsForOrganization(currentOrganization.id)
      ),
      withIoioStudentLoadStage(
        "5 shared shell query (working hours)",
        isStudentIoioRequest,
        () => getWorkingHoursForOrganization(currentOrganization.id)
      ),
      currentOrganizationUserRoles?.[0]
        ? withIoioStudentLoadStage(
            "5 shared shell query (unread update count)",
            isStudentIoioRequest,
            () =>
              getUnreadCountForUser({
                userId: authSession.userId,
                userRole: currentOrganizationUserRoles[0],
              })
          )
        : Promise.resolve(0),
      isIoioStaff
        ? getLabStatus({ organizationId: currentOrganization.id })
        : Promise.resolve(null),
      isIoioStaff || isIoioTA
        ? getAssignedOpenLabTaskCount({
            organizationId: currentOrganization.id,
            userId: authSession.userId,
          })
        : Promise.resolve(0),
      !isIoioStaff &&
      !isIoioTA &&
      currentOrganizationUserRoles.includes(OrganizationRoles.SELF_SERVICE)
        ? withIoioStudentLoadStage(
            "2 annual borrowing access lookup",
            isStudentIoioRequest,
            () =>
              getStudentAnnualAccessApproval({
                organizationId: currentOrganization.id,
                userId: authSession.userId,
                diagnostics: isStudentIoioRequest,
              })
          )
        : Promise.resolve(null),
    ]);

    const studentIoioNotifications =
      !isIoioStaff && !isIoioTA && annualAccessApproval
        ? await withIoioStudentLoadStage(
            "3 Student notifications (approval-notification query included)",
            isStudentIoioRequest,
            () =>
              getStudentIoioNotifications({
                organizationId: currentOrganization.id,
                userId: authSession.userId,
                annualApproval: annualAccessApproval,
                diagnostics: isStudentIoioRequest,
              })
          )
        : null;
    if (isStudentIoioRequest && !annualAccessApproval) {
      logIoioStudentLoadStage(
        "3 Student notifications",
        "SKIPPED",
        isStudentIoioRequest
      );
    }

    return data(
      payload({
        user,
        organizations,
        currentOrganizationId: organizationId,
        bookingSettings,
        workingHours,
        currentOrganization,
        currentOrganizationUserRoles,
        isIoioStaff,
        isIoioTA,
        subscription,
        enablePremium: config.enablePremiumFeatures,
        hideNoticeCard: userPrefsCookie.hideNoticeCard,
        minimizedSidebar: userPrefsCookie.minimizedSidebar,
        scannerCameraId: userPrefsCookie.scannerCameraId as string | undefined,
        isAdmin,
        canUseBookings: canUseBookings(currentOrganization),
        canUseAudits: canUseAudits(currentOrganization),
        unreadUpdatesCount,
        hasUnpaidInvoice: user.hasUnpaidInvoice,
        warnForNoPaymentMethod: user.warnForNoPaymentMethod,
        needsSequentialIdMigration,
        labStatus,
        assignedLabTaskCount,
        annualAccessApproval,
        studentIoioNotifications,
        /** THis is used to disable team organizations when the currentOrg is Team and no subscription is present  */
        disabledTeamOrg: await withIoioStudentLoadStage(
          "5 organization workspace state",
          isStudentIoioRequest,
          () =>
            isAdmin
              ? false
              : currentOrganization.workspaceDisabled ||
                disabledTeamOrg({
                  currentOrganization,
                  organizations,
                  url: request.url,
                })
        ),
      }),
      {
        headers: [
          setCookie(await userPrefs.serialize(userPrefsCookie)),
          ...expireHostOnlyUserPrefsCookie(),
          ...(cookieRefreshNeeded
            ? [setCookie(await setSelectedOrganizationIdCookie(organizationId))]
            : []),
        ],
      }
    );
  } catch (cause) {
    logIoioStudentLoadFailure(
      "1 shared authenticated-layout loader boundary (unclassified)",
      cause,
      isStudentIoioRequestPath
    );
    const reason = makeShelfError(cause, { userId: authSession.userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ error }) => {
  if (!error) {
    return [{ title: "" }];
  }

  let title = "Something went wrong";

  if (isRouteError(error)) {
    title = error.data.error?.title ?? "";
  } else if (isLikeShelfError(error)) {
    title = error?.title ?? "";
  } else if (error instanceof Error) {
    title = error.name;
  }

  return [
    /** This will make sure that if we have an error its visible in the title of the browser tab */
    { title: appendToMetaTitle(title) },
  ];
};

export default function App() {
  useCrisp();
  const {
    disabledTeamOrg,
    hasUnpaidInvoice,
    warnForNoPaymentMethod,
    minimizedSidebar,
    needsSequentialIdMigration,
    currentOrganizationId,
    currentOrganizationUserRoles,
    isIoioStaff,
    isIoioTA,
  } = useLoaderData<typeof loader>();
  const isHydrated = useHydrated();
  const location = useLocation();
  const isIoioStudentSurface =
    location.pathname === "/ioio" ||
    location.pathname.startsWith("/ioio/") ||
    location.pathname === "/handbook" ||
    location.pathname.startsWith("/handbook/");
  // Several authenticated routes (assets._index, kits._index, locations.*, …)
  // call `userHasPermission` from `permission.validator.client` during their
  // component render. That module is `.client.ts`, so RR7's vite plugin
  // stubs every export to `undefined` in the server bundle — calling them
  // during SSR throws `TypeError: userHasPermission is not a function`.
  // Until those call sites are lifted into loaders (or wrapped in
  // ClientOnly), we suppress route SSR rendering by showing the workspace
  // spinner until the client has hydrated. This matches the prior status
  // quo, when `switchingWorkspaceAtom` defaulted to `true` and produced the
  // same one-frame spinner on every full reload.
  //
  // This also covers a workspace switch: that posts as a native document
  // submission, so the new workspace arrives as a fresh document and shows
  // this spinner while it hydrates.
  // TODO: lift `userHasPermission` checks into route loaders so SSR works.
  const workspaceSwitching = !isHydrated;
  const roleResolved =
    resolveIoioAccountSurface(currentOrganizationUserRoles) !== null;
  const isStudentOnly =
    currentOrganizationUserRoles?.includes(OrganizationRoles.SELF_SERVICE) &&
    !isIoioStaff;
  const isLabToolsRoute =
    location.pathname === "/operations/tasks" ||
    location.pathname === "/purchasing" ||
    location.pathname === "/ta-hours";
  const isBlockedStudentStaffRoute =
    isStudentOnly &&
    isIoioStaffRoute(location.pathname) &&
    !(isLabToolsRoute && isIoioTA);
  const toolsOnlyTAView = isStudentOnly && isIoioTA && isLabToolsRoute;
  const [feedbackModalOpen, setFeedbackModalOpen] = useAtom(
    feedbackModalOpenAtom
  );

  return (
    <CommandPaletteRoot>
      <SidebarProvider defaultOpen={!minimizedSidebar}>
        <SkipLinks />
        <AtomsResetHandler />
        <SidebarInset id="main-content" tabIndex={-1}>
          {warnForNoPaymentMethod ? <MissingPaymentMethodBanner /> : null}
          {hasUnpaidInvoice ? <UnpaidInvoiceBanner /> : null}
          {disabledTeamOrg ? (
            <NoSubscription />
          ) : workspaceSwitching ||
            !roleResolved ||
            isBlockedStudentStaffRoute ? (
            <div className="flex size-full flex-col items-center justify-center text-center">
              <Spinner />
              <p className="mt-2">Activating workspace...</p>
            </div>
          ) : isIoioStudentSurface && !isIoioStaff ? (
            <Outlet />
          ) : (
            <StaffShell toolsOnly={toolsOnlyTAView} />
          )}
          <Toaster />

          {/* Sequential ID Migration Modal */}
          {needsSequentialIdMigration ? (
            // `key` remounts the modal when the active organization changes,
            // resetting its internal state without needing a derived-state effect.
            <SequentialIdMigrationModal
              key={currentOrganizationId}
              organizationId={currentOrganizationId}
            />
          ) : null}

          <FeedbackModal
            open={feedbackModalOpen}
            onClose={() => setFeedbackModalOpen(false)}
          />
        </SidebarInset>
      </SidebarProvider>
    </CommandPaletteRoot>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
