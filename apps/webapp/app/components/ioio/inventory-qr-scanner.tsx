import { useRef, useState } from "react";
import { ScanQrCode } from "lucide-react";
import { useNavigate } from "react-router";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import { CodeScanner } from "~/components/scanner/code-scanner";
import { Button } from "~/components/shared/button";
import type { QrScanAudience } from "~/modules/ioio/scan-qr";

export function InventoryQrScanner({ audience }: { audience: QrScanAudience }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string>();
  const requestInFlight = useRef(false);

  const close = () => {
    setOpen(false);
    setPaused(false);
    setError(undefined);
    requestInFlight.current = false;
  };

  const scan = async ({
    value,
    error: scannerError,
  }: {
    value: string;
    error?: string;
  }) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setPaused(true);
    if (scannerError) {
      setError("QR code not recognized. Please try again.");
      return;
    }

    try {
      const params = new URLSearchParams({ value, audience });
      const response = await fetch(`/api/ioio/inventory-qr?${params}`);
      const result = (await response.json()) as {
        destination?: string;
        error?: string;
      };
      if (!response.ok || !result.destination) {
        setError(result.error ?? "QR code not recognized. Please try again.");
        return;
      }
      close();
      void navigate(result.destination);
    } catch {
      setError("We couldn't read that QR code. Please try again.");
    }
  };

  const resume = (nextPaused: boolean) => {
    if (!nextPaused) {
      requestInFlight.current = false;
      setError(undefined);
    }
    setPaused(nextPaused);
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <ScanQrCode aria-hidden="true" className="mr-2 size-4" />
        Scan QR code
      </Button>
      <DialogPortal>
        <Dialog
          title="Scan QR code"
          open={open}
          onClose={close}
          className="h-dvh w-full md:h-auto md:w-[640px] md:max-w-[calc(100vw-3rem)]"
          wrapperClassName="z-[100]"
        >
          {open ? (
            <div className="h-[min(70vh,560px)] min-h-[400px] p-4">
              <CodeScanner
                onCodeDetectionSuccess={scan}
                allowNonShelfCodes
                forceMode="camera"
                hideBackButtonText
                overlayPosition="centered"
                paused={paused}
                setPaused={resume}
                errorTitle="Unable to scan QR code"
                errorMessage={error}
                scanMessage="Opening inventory…"
                onCameraError={(message) => {
                  setError(message);
                  setPaused(true);
                }}
                className="rounded-lg"
              />
            </div>
          ) : null}
        </Dialog>
      </DialogPortal>
    </>
  );
}
