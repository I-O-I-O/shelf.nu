import type { ButtonProps } from "~/components/shared/button";
import { Button } from "~/components/shared/button";
import { tw } from "~/utils/tw";

/** IOIO auth primary action, built on Shelf's shared Button component. */
export function IoioAuthPrimaryButton({
  className,
  width = "full",
  ...props
}: ButtonProps) {
  return (
    <Button
      {...props}
      variant="primary"
      width={width}
      className={tw(
        "min-h-11 rounded-xl border-red-700 bg-red-700 text-center text-white focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 enabled:hover:border-red-800 enabled:hover:bg-red-800 disabled:border-red-300 disabled:bg-red-300",
        className
      )}
    />
  );
}
