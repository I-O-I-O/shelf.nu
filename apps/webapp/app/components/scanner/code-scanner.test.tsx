import { forwardRef } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as CodeScannerModule from "~/components/scanner/code-scanner";
import { handleDetection } from "~/components/scanner/utils";

type WebcamMockProps = {
  onUserMedia?: () => void;
  onUserMediaError?: (error: unknown) => void;
  videoConstraints?: MediaTrackConstraints;
};

const webcamMockProps: { current: WebcamMockProps | null } = { current: null };

// why: testing scanner logic without requiring actual camera hardware access
vi.mock("react-webcam", () => {
  const MockWebcam = forwardRef<HTMLVideoElement, WebcamMockProps>(
    (props, _ref) => {
      if (props) {
        webcamMockProps.current = props;
      }
      return null;
    }
  );
  MockWebcam.displayName = "MockWebcam";

  return {
    __esModule: true,
    default: MockWebcam,
  };
});

// why: isolating scanner logic from success animation rendering
vi.mock("~/components/scanner/success-animation", () => ({
  __esModule: true,
  default: () => null,
}));

// why: testing scanner input parsing separately from QR code detection logic
vi.mock("~/components/scanner/utils", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    handleDetection: vi.fn().mockResolvedValue(undefined),
  };
});

let CodeScanner: typeof CodeScannerModule.CodeScanner;
let handleScannerInputValue: typeof CodeScannerModule.handleScannerInputValue;

const originalNavigator = globalThis.navigator;
const originalIsSecureContext = Object.getOwnPropertyDescriptor(
  window,
  "isSecureContext"
);

function setIsSecureContext(isSecureContext: boolean) {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: isSecureContext,
  });
}

beforeAll(async () => {
  const module = await import("~/components/scanner/code-scanner");
  CodeScanner = module.CodeScanner;
  handleScannerInputValue = module.handleScannerInputValue;
});

beforeEach(() => {
  // Ensure navigator.mediaDevices is available for tests that rely on it
  const existingNavigator = globalThis.navigator ?? ({} as Navigator);
  const navigatorWithMediaDevices = {
    ...existingNavigator,
    mediaDevices: {
      enumerateDevices: vi.fn().mockResolvedValue([]),
      getUserMedia: vi.fn(),
    },
  } as unknown as Navigator;

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigatorWithMediaDevices,
  });
  setIsSecureContext(true);
});

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: originalNavigator,
  });
  if (originalIsSecureContext) {
    Object.defineProperty(window, "isSecureContext", originalIsSecureContext);
  } else {
    Reflect.deleteProperty(window, "isSecureContext");
  }
  webcamMockProps.current = null;
});

describe("handleScannerInputValue", () => {
  it("triggers a SAM ID detection when the value matches the pattern", async () => {
    const onSuccess = vi.fn();

    const processed = await handleScannerInputValue!({
      rawValue: "sam-0012",
      paused: false,
      onCodeDetectionSuccess: onSuccess,
      allowNonShelfCodes: false,
    });

    expect(processed).toBe(true);
    expect(onSuccess).toHaveBeenCalledWith({
      value: "SAM-0012",
      type: "samId",
    });
    expect(handleDetection).not.toHaveBeenCalled();
  });

  it("returns false and skips detection when the scanner is paused", async () => {
    const onSuccess = vi.fn();

    const processed = await handleScannerInputValue!({
      rawValue: "sam-0012",
      paused: true,
      onCodeDetectionSuccess: onSuccess,
      allowNonShelfCodes: false,
    });

    expect(processed).toBe(false);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(handleDetection).not.toHaveBeenCalled();
  });

  it("delegates to handleDetection for non SAM inputs", async () => {
    const onSuccess = vi.fn();

    const processed = await handleScannerInputValue!({
      rawValue: "QR123",
      paused: false,
      onCodeDetectionSuccess: onSuccess,
      allowNonShelfCodes: false,
    });

    expect(processed).toBe(true);
    expect(handleDetection).toHaveBeenCalledWith({
      result: "QR123",
      onCodeDetectionSuccess: onSuccess,
      allowNonShelfCodes: false,
      paused: false,
    });
  });
});

describe("CodeScanner", () => {
  it("shows a custom error title when provided", () => {
    const Scanner = CodeScanner!;

    render(
      <Scanner
        onCodeDetectionSuccess={() => {}}
        paused
        setPaused={() => {}}
        scanMessage=""
        errorMessage="Unable to find SAM ID"
        errorTitle="SAM ID not found"
        forceMode="scanner"
        allowNonShelfCodes
      />
    );

    expect(screen.getByText("SAM ID not found")).toBeInTheDocument();
    expect(screen.getByText("Unable to find SAM ID")).toBeInTheDocument();
  });

  it("retries camera initialization with a back camera device when facingMode fails", async () => {
    const enumerateDevicesMock = vi
      .spyOn(globalThis.navigator.mediaDevices, "enumerateDevices")
      .mockResolvedValue([
        {
          deviceId: "front-camera",
          kind: "videoinput",
          label: "Front Camera",
          groupId: "group-1",
          toJSON() {
            return this;
          },
        } as MediaDeviceInfo,
        {
          deviceId: "back-camera",
          kind: "videoinput",
          label: "Ultra Wide Back Camera",
          groupId: "group-1",
          toJSON() {
            return this;
          },
        } as MediaDeviceInfo,
      ]);

    const Scanner = CodeScanner!;

    render(
      <Scanner
        onCodeDetectionSuccess={() => {}}
        paused={false}
        setPaused={() => {}}
        scanMessage=""
        errorMessage=""
        forceMode="camera"
        allowNonShelfCodes
      />
    );

    await waitFor(() => {
      expect(webcamMockProps.current).toBeTruthy();
    });

    expect(webcamMockProps.current?.videoConstraints).toEqual({
      facingMode: "environment",
    });

    const initialError = {
      name: "OverconstrainedError",
      message: "Requested device not found",
    } satisfies Pick<DOMException, "name" | "message">;

    await act(async () => {
      await Promise.resolve(
        webcamMockProps.current?.onUserMediaError?.(initialError)
      );
    });

    await waitFor(() => {
      expect(webcamMockProps.current?.videoConstraints).toEqual({
        deviceId: "back-camera",
      });
    });

    expect(enumerateDevicesMock).toHaveBeenCalled();
    expect(screen.queryByText(/Camera error/i)).not.toBeInTheDocument();
  });

  it("shows an HTTPS requirement and skips react-webcam in an insecure context", async () => {
    setIsSecureContext(false);

    const Scanner = CodeScanner!;

    render(
      <Scanner
        onCodeDetectionSuccess={() => {}}
        paused={false}
        setPaused={() => {}}
        forceMode="camera"
      />
    );

    expect(
      await screen.findByText(
        "Camera scanning requires a secure HTTPS connection."
      )
    ).toBeInTheDocument();
    expect(webcamMockProps.current).toBeNull();
  });

  it("mounts react-webcam in a secure context with getUserMedia", async () => {
    const Scanner = CodeScanner!;

    render(
      <Scanner
        onCodeDetectionSuccess={() => {}}
        paused={false}
        setPaused={() => {}}
        forceMode="camera"
      />
    );

    await waitFor(() => {
      expect(webcamMockProps.current).toBeTruthy();
    });
  });

  it("shows an unsupported-browser message when secure but getUserMedia is missing", async () => {
    const existingNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        ...existingNavigator,
        mediaDevices: {
          enumerateDevices: vi.fn().mockResolvedValue([]),
        },
      },
    });

    const Scanner = CodeScanner!;

    render(
      <Scanner
        onCodeDetectionSuccess={() => {}}
        paused={false}
        setPaused={() => {}}
        forceMode="camera"
      />
    );

    expect(
      await screen.findByText(
        "Camera scanning is not supported in this browser. Use a supported browser with camera access."
      )
    ).toBeInTheDocument();
    expect(webcamMockProps.current).toBeNull();
  });
});
