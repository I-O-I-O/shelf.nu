import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRoutesStub, redirect } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as loadLegacyFoundRoute } from "~/routes/_layout+/ioio.found";
import IoioReport, {
  action as submitIoioReport,
} from "~/routes/_layout+/ioio.report";

const actionMocks = vi.hoisted(() => ({
  db: {
    asset: { findFirst: vi.fn(), count: vi.fn() },
    location: { findMany: vi.fn() },
    ioioWriteOperation: { findMany: vi.fn() },
  },
  requireStudentRead: vi.fn(),
  prepareReportProblem: vi.fn(),
  reportProblem: vi.fn(),
  createBorrowedItemProblemReport: vi.fn(),
  getBorrowedItemProblemContext: vi.fn(),
  getStudentKits: vi.fn(),
  getStudentReportLocations: vi.fn(),
}));

// why: the route stub supplies the loader/action outcomes; database modules
// are unrelated to verifying the Student form's ordering and feedback.
vi.mock("~/database/db.server", () => ({ db: actionMocks.db }));
vi.mock("~/modules/ioio-student/report-problem.server", () => ({
  createBorrowedItemProblemReport: actionMocks.createBorrowedItemProblemReport,
  getBorrowedItemProblemContext: actionMocks.getBorrowedItemProblemContext,
  prepareReportProblem: actionMocks.prepareReportProblem,
  reportProblem: actionMocks.reportProblem,
}));
vi.mock("~/modules/ioio-student/service.server", () => ({
  getStudentAssets: vi.fn(),
  getStudentKits: actionMocks.getStudentKits,
  getStudentReportLocations: actionMocks.getStudentReportLocations,
}));
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentRead: actionMocks.requireStudentRead,
}));
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  getIoioArchivedItemIds: vi.fn().mockResolvedValue([]),
  IOIO_ARCHIVE_ITEM_TYPE: { ASSET: "ASSET" },
}));
const loaderData = {
  mode: "generic" as const,
  assets: [
    {
      id: "makey-product",
      label: "Makey Kit",
      units: [
        { id: "makey-unit-001", label: "#001", reported: false },
        { id: "makey-unit-002", label: "#002", reported: false },
      ],
      defaultUnitId: null,
    },
    {
      id: "camera-product",
      label: "Camera",
      units: [{ id: "camera-unit-001", label: "#001", reported: false }],
      defaultUnitId: "camera-unit-001",
    },
  ],
  locations: [
    {
      id: "room-1",
      name: "B477",
      parentId: null,
      imageUrl: null,
      thumbnailUrl: null,
      assetCount: 0,
      children: [
        {
          id: "section-1",
          name: "Electronics",
          parentId: "room-1",
          imageUrl: null,
          thumbnailUrl: null,
          assetCount: 0,
          children: [
            {
              id: "shelf-b",
              name: "Shelf B",
              parentId: "section-1",
              imageUrl: null,
              thumbnailUrl: null,
              assetCount: 0,
              children: [],
            },
          ],
        },
      ],
    },
  ],
  selectedProductId: null,
  selectedUnitId: null,
  kits: [{ id: "grove-kit", name: "Grove Kit" }],
  selectedProblemType: null as "FOUND_SOMETHING" | null,
};

function renderReport(action = vi.fn(() => ({ ok: true })), data = loaderData) {
  const Stub = createRoutesStub([
    {
      path: "/ioio/report",
      Component: IoioReport,
      loader: () => data,
      action,
      HydrateFallback: () => null,
    },
    {
      path: "/ioio",
      Component: () => <div role="status">Report sent.</div>,
    },
  ]);
  return render(<Stub initialEntries={["/ioio/report"]} />);
}

function chooseMakeyProduct() {
  fireEvent.change(screen.getByLabelText("What item is this about?"), {
    target: { value: "Makey" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Makey Kit/ }));
}

function chooseShelfLocation() {
  fireEvent.change(screen.getByLabelText("Room"), {
    target: { value: "room-1" },
  });
  fireEvent.change(screen.getByLabelText("Section"), {
    target: { value: "section-1" },
  });
  fireEvent.change(screen.getByLabelText("Shelf"), {
    target: { value: "shelf-b" },
  });
}

describe("IOIO Student report form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the issue selector first, then only the fields needed for a damaged item", async () => {
    renderReport();
    await screen.findByRole("heading", { name: "Report" });

    const form = document.querySelector("form")!;
    expect(form.querySelector("label")?.textContent).toContain(
      "What happened?"
    );
    expect(form.querySelector('[name="productId"]')).toBeNull();
    expect(screen.queryByLabelText("Which unit?")).toBeNull();

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "DAMAGED" },
    });
    expect(screen.getByLabelText("What item is this about?")).toBeRequired();
    expect(form.querySelector('[name="locationId"]')).toBeNull();
    chooseMakeyProduct();
    expect(screen.getByLabelText("Which unit?")).toBeRequired();

    expect(form.querySelector("[name=content]")).toBeTruthy();
  });

  it("disables only the unresolved reported unit in the exact-unit selector", async () => {
    const reportedData = {
      ...loaderData,
      assets: [
        {
          ...loaderData.assets[0],
          units: [
            { id: "makey-unit-001", label: "#001", reported: false },
            {
              id: "makey-unit-002",
              label: "#002 — Reported",
              reported: true,
            },
          ],
        },
        loaderData.assets[1],
      ],
    };
    renderReport(undefined, reportedData);
    await screen.findByRole("heading", { name: "Report" });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "DAMAGED" },
    });
    chooseMakeyProduct();

    expect(
      screen.getByRole("option", { name: "#002 — Reported" })
    ).toBeDisabled();
    expect(screen.getByRole("option", { name: "#001" })).not.toBeDisabled();
    expect(
      screen.getByText(
        "Reported units are waiting for Staff review and cannot be selected again."
      )
    ).toBeTruthy();
  });

  it("keeps the exact unit optional for Item missing after a logical item is selected", async () => {
    renderReport();
    await screen.findByRole("heading", { name: "Report" });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "MISSING" },
    });
    expect(screen.getByLabelText("What item is this about?")).toBeRequired();
    chooseMakeyProduct();
    expect(screen.getByLabelText(/Which unit/)).not.toBeRequired();
  });

  it("shows only the asset field for Can't find item and clears a stale unit", async () => {
    renderReport();
    await screen.findByRole("heading", { name: "Report" });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "DAMAGED" },
    });
    chooseMakeyProduct();
    fireEvent.change(screen.getByLabelText("Which unit?"), {
      target: { value: "makey-unit-002" },
    });

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "CANT_FIND" },
    });
    expect(
      screen.getByLabelText("What item is this about?")
    ).not.toBeRequired();
    expect(document.querySelector('[name="unitId"]')).toBeNull();
    expect(document.querySelector('[name="locationId"]')).toBeNull();

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "DAMAGED" },
    });
    expect(screen.getByLabelText("Which unit?")).toHaveValue("");
  });

  it("uses only a kit selector for Kit incomplete and clears stale unit context", async () => {
    renderReport();
    await screen.findByRole("heading", { name: "Report" });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "DAMAGED" },
    });
    chooseMakeyProduct();
    fireEvent.change(screen.getByLabelText("Which unit?"), {
      target: { value: "makey-unit-002" },
    });

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "KIT_INCOMPLETE" },
    });

    expect(screen.getByLabelText("Which kit?")).toBeRequired();
    expect(screen.queryByLabelText("What item is this about?")).toBeNull();
    expect(screen.queryByLabelText("Which unit?")).toBeNull();
    expect(document.querySelector('[name="productId"]')).toBeNull();
    expect(document.querySelector('[name="unitId"]')).toBeNull();
    expect(document.querySelector('[name="content"]')).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Which kit?"), {
      target: { value: "grove-kit" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "One sensor is missing." },
    });
    const form = new FormData(document.querySelector("form")!);
    expect(form.get("kitId")).toBe("grove-kit");
    expect(form.get("productId")).toBeNull();
    expect(form.get("unitId")).toBeNull();
  });

  it("shows a required location and no asset or unit for Location full", async () => {
    renderReport();
    await screen.findByRole("heading", { name: "Report" });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "LOCATION_FULL" },
    });

    expect(screen.getByLabelText("Room")).toBeRequired();
    expect(screen.getByText("Select room")).toBeTruthy();
    expect(document.querySelectorAll('[name="locationId"]')).toHaveLength(1);
    expect(document.querySelector('[name="productId"]')).toBeNull();
    expect(document.querySelector('[name="unitId"]')).toBeNull();
    expect(screen.queryByText("Pick a room")).toBeNull();
    expect(screen.queryByText("Pick a shelf")).toBeNull();
    expect(screen.queryByText("Create new location")).toBeNull();
  });

  it("shows item, exact unit, and location for Wrong location", async () => {
    renderReport();
    await screen.findByRole("heading", { name: "Report" });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "WRONG_LOCATION" },
    });
    chooseMakeyProduct();

    expect(screen.getByLabelText("Which unit?")).toBeRequired();
    expect(screen.getByLabelText("Room")).toBeRequired();
    fireEvent.change(screen.getByLabelText("Room"), {
      target: { value: "room-1" },
    });
    expect(screen.getByLabelText("Section")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Electronics" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Shelf B" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Section"), {
      target: { value: "section-1" },
    });
    fireEvent.change(screen.getByLabelText("Shelf"), {
      target: { value: "shelf-b" },
    });
    expect(document.querySelector('[name="locationId"]')).toHaveValue(
      "shelf-b"
    );
    expect(document.querySelectorAll('[name="locationId"]')).toHaveLength(1);
    expect(screen.queryByText("Create new location")).toBeNull();
  });

  it("shows Found something and only Description for Other", async () => {
    renderReport();
    await screen.findByRole("heading", { name: "Report" });
    const issueSelect = screen.getByLabelText("What happened?");
    expect(
      screen.getByRole("option", { name: "Found something" })
    ).toBeTruthy();
    fireEvent.change(issueSelect, { target: { value: "OTHER" } });

    expect(screen.getByLabelText("Description")).toBeTruthy();
    expect(document.querySelector('[name="productId"]')).toBeNull();
    expect(document.querySelector('[name="unitId"]')).toBeNull();
    expect(document.querySelector('[name="locationId"]')).toBeNull();
  });

  it("clears stale item and location selections when they stop applying", async () => {
    renderReport();
    await screen.findByRole("heading", { name: "Report" });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "WRONG_LOCATION" },
    });
    chooseMakeyProduct();
    fireEvent.change(screen.getByLabelText("Which unit?"), {
      target: { value: "makey-unit-002" },
    });
    chooseShelfLocation();

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "LOCATION_FULL" },
    });
    expect(document.querySelector('[name="productId"]')).toBeNull();
    expect(document.querySelector('[name="unitId"]')).toBeNull();
    expect(document.querySelector('[name="locationId"]')).toHaveValue(
      "shelf-b"
    );

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "DAMAGED" },
    });
    expect(document.querySelector('[name="locationId"]')).toBeNull();
    expect(screen.getByLabelText("What item is this about?")).toHaveValue("");

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "LOCATION_FULL" },
    });
    chooseShelfLocation();
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "OTHER" },
    });
    expect(document.querySelector('[name="locationId"]')).toBeNull();
  });

  it("does not submit hidden item or unit values after changing to Location full", async () => {
    let submittedForm: FormData | null = null;
    const action = vi.fn(async ({ request }: { request: Request }) => {
      submittedForm = await request.formData();
      return redirect("/ioio");
    });
    renderReport(action);
    await screen.findByRole("heading", { name: "Report" });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "WRONG_LOCATION" },
    });
    chooseMakeyProduct();
    fireEvent.change(await screen.findByLabelText("Which unit?"), {
      target: { value: "makey-unit-002" },
    });
    chooseShelfLocation();
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "LOCATION_FULL" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "This location is full." },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    });

    expect(submittedForm?.get("productId")).toBeNull();
    expect(submittedForm?.get("unitId")).toBeNull();
    expect(submittedForm?.get("locationId")).toBe("shelf-b");
  });

  it("submits the selected physical unit through the existing report service", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.db.asset.findFirst
      .mockResolvedValueOnce({
        id: "makey-product",
        title: "Makey Kit #001",
        type: "INDIVIDUAL",
        assetModelId: "makey-model",
        assetKits: [],
      })
      .mockResolvedValueOnce({ id: "makey-unit-002", assetKits: [] });
    actionMocks.db.asset.count.mockResolvedValue(5);
    actionMocks.prepareReportProblem.mockResolvedValue({
      confirmationToken: "proposal-1",
    });
    actionMocks.reportProblem.mockResolvedValue({
      ok: true,
      status: "submitted",
      reportId: "report-damaged",
    });
    const form = new FormData();
    form.set("productId", "makey-product");
    form.set("unitId", "makey-unit-002");
    form.set("problemType", "DAMAGED");
    form.set("content", "The casing is cracked.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report", {
        method: "POST",
        body: form,
      }),
      params: {},
    });

    expect(actionMocks.prepareReportProblem).toHaveBeenCalledWith(
      {
        report_type: "ITEM_DAMAGED",
        asset_id: "makey-unit-002",
        kit_id: null,
        location_id: null,
        description: "The casing is cracked.",
      },
      expect.anything(),
      { source: "IOIO_STUDENT_REPORT" }
    );
    expect(actionMocks.reportProblem).toHaveBeenCalledWith(
      {
        confirmationToken: "proposal-1",
        reportType: "ITEM_DAMAGED",
        description: "The casing is cracked.",
      },
      expect.anything()
    );
    expect(actionMocks.reportProblem).toHaveBeenCalledTimes(1);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe(
      "/ioio/report/complete?reportId=report-damaged"
    );
  });

  it("routes a serious borrowed-unit report to the same item completion screen", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.createBorrowedItemProblemReport.mockResolvedValue({
      ok: true,
      reportId: "report-borrowed-damaged",
      assetType: "INDIVIDUAL",
    });
    const form = new FormData();
    form.set("bookingId", "booking-1");
    form.set("bookingAssetId", "booking-asset-1");
    form.set("assetId", "unit-003");
    form.set("submissionToken", "123e4567-e89b-42d3-a456-426614174000");
    form.set("problemType", "DAMAGED");
    form.set("content", "The casing is cracked.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report", {
        method: "POST",
        body: form,
      }),
      params: {},
    });

    expect((response as Response).headers.get("Location")).toBe(
      "/ioio/report/complete?reportId=report-borrowed-damaged"
    );
    expect(actionMocks.createBorrowedItemProblemReport).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "unit-003",
        reportType: "ITEM_DAMAGED",
      }),
      expect.anything(),
      {
        source: "IOIO_STUDENT_REPORT",
        submissionToken: "123e4567-e89b-42d3-a456-426614174000",
      }
    );
  });

  it.each([
    { formValue: "DAMAGED", reportType: "ITEM_DAMAGED" },
    { formValue: "MISSING_PART", reportType: "PART_MISSING" },
    { formValue: "NOT_WORKING", reportType: "ITEM_NOT_WORKING" },
    { formValue: "OTHER", reportType: "OTHER" },
  ])(
    "preserves active-loan $formValue as $reportType with exact loan context",
    async ({ formValue, reportType }) => {
      actionMocks.requireStudentRead.mockResolvedValue({
        userId: "student-1",
        organizationId: "team-1",
        role: "SELF_SERVICE",
      });
      actionMocks.createBorrowedItemProblemReport.mockResolvedValue({
        ok: true,
        reportId: `report-${formValue.toLowerCase()}`,
        assetType: "INDIVIDUAL",
      });
      const form = new FormData();
      form.set("bookingId", "booking-1");
      form.set("bookingAssetId", "booking-asset-1");
      form.set("assetId", "unit-003");
      form.set("submissionToken", "123e4567-e89b-42d3-a456-426614174000");
      form.set("problemType", formValue);
      form.set("content", "The item needs staff attention.");

      const response = await submitIoioReport({
        context: {} as never,
        request: new Request("http://localhost/ioio/report", {
          method: "POST",
          body: form,
        }),
        params: {},
      } as never);

      expect(actionMocks.createBorrowedItemProblemReport).toHaveBeenCalledWith(
        {
          bookingId: "booking-1",
          bookingAssetId: "booking-asset-1",
          assetId: "unit-003",
          reportType,
          description: "The item needs staff attention.",
        },
        expect.anything(),
        {
          source: "IOIO_STUDENT_REPORT",
          submissionToken: "123e4567-e89b-42d3-a456-426614174000",
        }
      );
      expect((response as Response).headers.get("Location")).toBe(
        `/ioio/report/complete?reportId=report-${formValue.toLowerCase()}`
      );
    }
  );

  it("routes Found something through the canonical report proposal and completion flow", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.prepareReportProblem.mockResolvedValue({
      confirmationToken: "proposal-found",
    });
    actionMocks.reportProblem.mockResolvedValue({ reportId: "report-found" });
    const form = new FormData();
    form.set("problemType", "FOUND_SOMETHING");
    form.set("content", "I found an unclaimed USB adapter.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report?mode=found", {
        method: "POST",
        body: form,
      }),
      params: {},
    } as never);

    expect(actionMocks.prepareReportProblem).toHaveBeenCalledWith(
      {
        report_type: "FOUND_SOMETHING",
        asset_id: null,
        kit_id: null,
        location_id: null,
        description: "I found an unclaimed USB adapter.",
      },
      expect.anything(),
      { source: "IOIO_STUDENT_REPORT" }
    );
    expect(actionMocks.reportProblem).toHaveBeenCalledWith(
      {
        confirmationToken: "proposal-found",
        reportType: "FOUND_SOMETHING",
        description: "I found an unclaimed USB adapter.",
      },
      expect.anything()
    );
    expect((response as Response).headers.get("Location")).toBe(
      "/ioio/report/complete?reportId=report-found"
    );
  });

  it("submits Kit incomplete against the selected native kit without a physical unit", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.prepareReportProblem.mockResolvedValue({
      confirmationToken: "proposal-kit-incomplete",
    });
    actionMocks.reportProblem.mockResolvedValue({
      reportId: "report-kit-incomplete",
    });
    const form = new FormData();
    form.set("problemType", "KIT_INCOMPLETE");
    form.set("kitId", "grove-kit");
    form.set("content", "One sensor is missing.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report", {
        method: "POST",
        body: form,
      }),
      params: {},
    } as never);

    expect(actionMocks.prepareReportProblem).toHaveBeenCalledWith(
      {
        report_type: "KIT_INCOMPLETE",
        asset_id: null,
        kit_id: "grove-kit",
        location_id: null,
        description: "One sensor is missing.",
      },
      expect.anything(),
      { source: "IOIO_STUDENT_REPORT" }
    );
    expect(actionMocks.db.asset.findFirst).not.toHaveBeenCalled();
    expect((response as Response).headers.get("Location")).toBe(
      "/ioio/report/complete?reportId=report-kit-incomplete"
    );
  });

  it("rejects Kit incomplete without a kit selection", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    const form = new FormData();
    form.set("problemType", "KIT_INCOMPLETE");
    form.set("content", "One sensor is missing.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report", {
        method: "POST",
        body: form,
      }),
      params: {},
    } as never);

    expect(response).toHaveProperty(
      "data.error.message",
      "Choose the kit this report is about."
    );
    expect(actionMocks.prepareReportProblem).not.toHaveBeenCalled();
  });

  it("rejects a stale optional item in a Found something report", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.db.asset.findFirst.mockResolvedValue(null);
    const form = new FormData();
    form.set("problemType", "FOUND_SOMETHING");
    form.set("productId", "asset-from-another-workspace");
    form.set("content", "I found an unclaimed USB adapter.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report?mode=found", {
        method: "POST",
        body: form,
      }),
      params: {},
    } as never);

    expect(response).toHaveProperty("data.error.message");
    expect(actionMocks.prepareReportProblem).not.toHaveBeenCalled();
    expect(actionMocks.reportProblem).not.toHaveBeenCalled();
  });

  it("preselects Found something and shows its optional item context", async () => {
    renderReport(undefined, {
      ...loaderData,
      selectedProblemType: "FOUND_SOMETHING",
    });
    await screen.findByRole("heading", { name: "Report" });

    expect(screen.getByLabelText("What happened?")).toHaveValue(
      "FOUND_SOMETHING"
    );
    expect(
      screen.getByLabelText("What item is this about? (optional)")
    ).toBeTruthy();
    expect(screen.queryByLabelText("Room")).toBeNull();
    expect(screen.getByText("Found something")).toBeTruthy();
  });

  it("keeps the old Found something URL as a redirect into the canonical form", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });

    const response = await loadLegacyFoundRoute({
      context: {} as never,
      request: new Request("http://localhost/ioio/found"),
      params: {},
    } as never);

    expect((response as Response).headers.get("Location")).toBe(
      "/ioio/report?mode=found"
    );
  });

  it.each([
    { formValue: "MISSING", reportType: "ITEM_MISSING" },
    { formValue: "CANT_FIND", reportType: "CANNOT_FIND" },
  ])(
    "keeps a $formValue report at logical-product level when no unit is selected",
    async ({ formValue, reportType }) => {
      actionMocks.requireStudentRead.mockResolvedValue({
        userId: "student-1",
        organizationId: "team-1",
        role: "SELF_SERVICE",
      });
      actionMocks.db.asset.findFirst.mockResolvedValue({
        id: "makey-product",
        title: "Makey Kit #001",
        type: "INDIVIDUAL",
        assetModelId: "makey-model",
        assetKits: [],
      });
      actionMocks.db.asset.count.mockResolvedValue(5);
      actionMocks.prepareReportProblem.mockResolvedValue({
        confirmationToken: "proposal-general",
      });
      actionMocks.reportProblem.mockResolvedValue({
        ok: true,
        reportId: `report-${formValue.toLowerCase()}`,
      });
      const form = new FormData();
      form.set("productId", "makey-product");
      form.set("problemType", formValue);
      form.set("content", "The item is not in its storage location.");

      const response = await submitIoioReport({
        context: {} as never,
        request: new Request("http://localhost/ioio/report", {
          method: "POST",
          body: form,
        }),
        params: {},
      });

      expect(actionMocks.prepareReportProblem).toHaveBeenCalledWith(
        {
          report_type: reportType,
          asset_id: null,
          kit_id: null,
          location_id: null,
          description:
            "Makey Kit (exact unit not specified): The item is not in its storage location.",
        },
        expect.anything(),
        { source: "IOIO_STUDENT_REPORT" }
      );
      expect(actionMocks.db.location.findMany).not.toHaveBeenCalled();
      expect((response as Response).headers.get("Location")).toBe(
        `/ioio/report/complete?reportId=report-${formValue.toLowerCase()}`
      );
    }
  );

  it("rejects a damaged logical product without an exact unit when it has siblings", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.db.asset.findFirst.mockResolvedValueOnce({
      id: "makey-product",
      title: "Makey Kit #001",
      type: "INDIVIDUAL",
      assetModelId: "makey-model",
      assetKits: [],
    });
    actionMocks.db.asset.count.mockResolvedValue(5);
    const form = new FormData();
    form.set("problemType", "DAMAGED");
    form.set("productId", "makey-product");
    form.set("content", "The item is damaged.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report", {
        method: "POST",
        body: form,
      }),
      params: {},
    });

    expect(response).toHaveProperty("data.error.message");
    expect(
      (response as { data: { error: { message: string } } }).data.error.message
    ).toBe("Choose the exact unit this report is about.");
    expect(actionMocks.prepareReportProblem).not.toHaveBeenCalled();
  });

  it("stores a wrong-location report with its selected Shelf Location", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.db.asset.findFirst
      .mockResolvedValueOnce({
        id: "makey-product",
        title: "Makey Kit #001",
        type: "INDIVIDUAL",
        assetModelId: "makey-model",
        assetKits: [],
      })
      .mockResolvedValueOnce({ id: "makey-unit-001", assetKits: [] });
    actionMocks.db.asset.count.mockResolvedValue(5);
    actionMocks.prepareReportProblem.mockResolvedValue({
      confirmationToken: "proposal-location",
    });
    actionMocks.reportProblem.mockResolvedValue({
      ok: true,
      status: "submitted",
      reportId: "report-location",
    });
    const form = new FormData();
    form.set("productId", "makey-product");
    form.set("unitId", "makey-unit-001");
    form.set("locationId", "shelf-b");
    form.set("problemType", "WRONG_LOCATION");
    form.set("content", "The camera is in the wrong cabinet.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report", {
        method: "POST",
        body: form,
      }),
      params: {},
    });

    expect((response as Response).headers.get("Location")).toBe(
      "/ioio/report/complete?reportId=report-location"
    );
    expect(actionMocks.prepareReportProblem).toHaveBeenCalledWith(
      expect.objectContaining({
        report_type: "WRONG_LOCATION",
        asset_id: "makey-unit-001",
        location_id: "shelf-b",
      }),
      expect.anything(),
      { source: "IOIO_STUDENT_REPORT" }
    );
  });

  it.each([
    {
      problemType: "LOCATION_FULL",
      productId: "",
      locationId: "",
      message: "Choose the Shelf location",
    },
    {
      problemType: "DAMAGED",
      productId: "",
      locationId: "",
      message: "Choose the item",
    },
    {
      problemType: "LOCATION_FULL",
      productId: "makey-product",
      locationId: "shelf-b",
      message: "does not use an item or unit",
    },
    {
      problemType: "DAMAGED",
      productId: "makey-product",
      locationId: "shelf-b",
      message: "does not use a location",
    },
    {
      problemType: "WRONG_LOCATION",
      productId: "makey-product",
      locationId: "",
      message: "Choose the Shelf location",
    },
    {
      problemType: "OTHER",
      productId: "makey-product",
      locationId: "shelf-b",
      message: "does not use an item or unit",
    },
    {
      problemType: "CANT_FIND",
      productId: "makey-product",
      locationId: "",
      message: "does not use an exact unit",
    },
  ])(
    "rejects invalid or stale $problemType context before saving",
    async ({ problemType, productId, locationId, message }) => {
      actionMocks.requireStudentRead.mockResolvedValue({
        userId: "student-1",
        organizationId: "team-1",
        role: "SELF_SERVICE",
      });
      const form = new FormData();
      form.set("problemType", problemType);
      form.set("productId", productId);
      form.set("unitId", productId ? "makey-unit-002" : "");
      form.set("locationId", locationId);
      form.set("content", "This report has enough detail.");

      const response = await submitIoioReport({
        context: {} as never,
        request: new Request("http://localhost/ioio/report", {
          method: "POST",
          body: form,
        }),
        params: {},
      });

      expect(response).toHaveProperty("data.error.message");
      expect(
        (response as { data: { error: { message: string } } }).data.error
          .message
      ).toContain(message);
      expect(actionMocks.prepareReportProblem).not.toHaveBeenCalled();
    }
  );

  it("stores Location full as a location-only report", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.prepareReportProblem.mockResolvedValue({
      confirmationToken: "proposal-location-full",
    });
    actionMocks.reportProblem.mockResolvedValue({ reportId: "report-full" });
    const form = new FormData();
    form.set("problemType", "LOCATION_FULL");
    form.set("locationId", "shelf-b");
    form.set("content", "There is no room for the returned kits.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report", {
        method: "POST",
        body: form,
      }),
      params: {},
    });

    expect(actionMocks.prepareReportProblem).toHaveBeenCalledWith(
      {
        report_type: "LOCATION_FULL",
        asset_id: null,
        kit_id: null,
        location_id: "shelf-b",
        description: "There is no room for the returned kits.",
      },
      expect.anything(),
      { source: "IOIO_STUDENT_REPORT" }
    );
    expect(actionMocks.db.asset.findFirst).not.toHaveBeenCalled();
    expect((response as Response).headers.get("Location")).toBe(
      "/ioio/report/complete?reportId=report-full"
    );
  });

  it("creates one report for a double click and follows the server redirect", async () => {
    const submissions: FormData[] = [];
    const action = vi.fn(async ({ request }: { request: Request }) => {
      submissions.push(await request.formData());
      return redirect("/ioio");
    });
    renderReport(action);
    await screen.findByRole("heading", { name: "Report" });

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "DAMAGED" },
    });
    chooseMakeyProduct();
    fireEvent.change(await screen.findByLabelText("Which unit?"), {
      target: { value: "makey-unit-002" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "The case is cracked." },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
      fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    });
    expect(submissions[0].get("productId")).toBe("makey-product");
    expect(submissions[0].get("unitId")).toBe("makey-unit-002");
    expect(await screen.findByRole("status")).toHaveTextContent("Report sent.");
    expect(screen.queryByRole("heading", { name: "Report" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit report" })).toBeNull();
  });

  it("runs the real submit action and renders the nested serious-report completion route", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.db.asset.findFirst
      .mockResolvedValueOnce({
        id: "makey-product",
        title: "Makey Kit #001",
        type: "INDIVIDUAL",
        assetModelId: "makey-model",
        assetKits: [],
      })
      .mockResolvedValueOnce({ id: "makey-unit-002", assetKits: [] });
    actionMocks.db.asset.count.mockResolvedValue(5);
    actionMocks.prepareReportProblem.mockResolvedValue({
      confirmationToken: "proposal-1",
    });
    actionMocks.reportProblem.mockResolvedValue({
      ok: true,
      status: "submitted",
      reportId: "report-damaged",
    });

    const Stub = createRoutesStub([
      {
        path: "/ioio/report",
        Component: IoioReport,
        loader: () => loaderData,
        action: submitIoioReport,
        children: [
          {
            path: "complete",
            loader: () => ({}),
            Component: () => (
              <div>
                <h1>Report received</h1>
                <p>Staff will inspect this item.</p>
                <a href="/ioio">Finish</a>
              </div>
            ),
          },
        ],
      },
    ]);
    render(<Stub initialEntries={["/ioio/report"]} />);
    await screen.findByRole("heading", { name: "Report" });

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "DAMAGED" },
    });
    chooseMakeyProduct();
    fireEvent.change(await screen.findByLabelText("Which unit?"), {
      target: { value: "makey-unit-002" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "The case is cracked." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit report" }));

    expect(
      await screen.findByRole("heading", { name: "Report received" })
    ).toBeTruthy();
    expect(screen.getByText("Staff will inspect this item.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Report" })).toBeNull();
    expect(actionMocks.reportProblem).toHaveBeenCalledTimes(1);
  });

  it("disables the submit button while the server action is pending", async () => {
    let resolveAction: (value: unknown) => void = () => undefined;
    const action = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        })
    );
    renderReport(action);
    await screen.findByRole("heading", { name: "Report" });
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "WRONG_LOCATION" },
    });
    chooseMakeyProduct();
    fireEvent.change(screen.getByLabelText("Which unit?"), {
      target: { value: "makey-unit-001" },
    });
    chooseShelfLocation();
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "It is on Shelf A1." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
    expect(
      await screen.findByRole("button", { name: "Submitting report…" })
    ).toBeDisabled();
    act(() => {
      resolveAction(redirect("/ioio"));
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Report sent.");
  });

  it("shows only the failure result when the action rejects the report", async () => {
    const action = vi.fn(() => ({
      error: { message: "The report could not be submitted." },
    }));
    renderReport(action);
    await screen.findByRole("heading", { name: "Report" });

    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "WRONG_LOCATION" },
    });
    chooseMakeyProduct();
    fireEvent.change(screen.getByLabelText("Which unit?"), {
      target: { value: "makey-unit-001" },
    });
    chooseShelfLocation();
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "It is on Shelf A1." },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
      await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    });

    expect(
      await screen.findByText("The report could not be submitted.")
    ).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveClass("bg-red-50", "text-red-800");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Place the item in/)).toBeNull();
    expect(screen.getByLabelText("Description")).toHaveValue(
      "It is on Shelf A1."
    );
  });

  it("keeps failed writes on the form without a completion redirect", async () => {
    actionMocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    actionMocks.prepareReportProblem.mockRejectedValue(
      new Error("The report could not be saved.")
    );
    const form = new FormData();
    form.set("productId", "");
    form.set("problemType", "OTHER");
    form.set("content", "A sign is damaged.");

    const response = await submitIoioReport({
      context: {} as never,
      request: new Request("http://localhost/ioio/report", {
        method: "POST",
        body: form,
      }),
      params: {},
    });

    expect(response).not.toBeInstanceOf(Response);
    expect(response).toHaveProperty("data.error.message");
  });
});
