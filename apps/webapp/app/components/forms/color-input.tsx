import type { ChangeEvent } from "react";
import { useRef, useState } from "react";
import { darkenColor } from "~/utils/color-contrast";
import { getRandomColor } from "~/utils/get-random-color";
import { tw } from "~/utils/tw";
import { InnerLabel } from "./inner-label";
import Input from "./input";

import { Button } from "../shared/button";

export const ColorInput = ({
  colorFromServer,
  showPreview = false,
  label = "Hex Color",
  className,
  inputClassName,
  ...rest
}: {
  colorFromServer?: string;
  showPreview?: boolean;
  label?: string;
  className?: string;
  inputClassName?: string;
  [key: string]: any;
}) => {
  // Re-sync with server-provided color when it changes (e.g. on save revalidation).
  // Uses the "store previous prop in a ref" pattern instead of useEffect to avoid a
  // render flash. See
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [color, setColor] = useState<string>(() => colorFromServer || "");
  const prevColorFromServer = useRef(colorFromServer);
  if (colorFromServer !== prevColorFromServer.current) {
    prevColorFromServer.current = colorFromServer;
    setColor(colorFromServer || "");
  }

  const handleColorChange = (e: ChangeEvent<HTMLInputElement>) => {
    setColor(() => `${e.target.value}`);
  };

  const handleRefresh = () => {
    setColor(() => `${getRandomColor()}`);
  };

  // Use darkened color for icon text to match Badge component
  const iconColor = color ? darkenColor(color, 0.5) : undefined;
  const isValidHexColor = /^#[0-9a-fA-F]{6}$/.test(color);
  const {
    name,
    disabled = false,
    error,
    hideErrorText,
    required,
    ...inputProps
  } = rest;

  if (showPreview) {
    return (
      <div className={tw("w-full", className)}>
        <InnerLabel required={required}>{label}</InnerLabel>
        <div className="flex items-center gap-2">
          <div
            data-test-id="categoryColorControl"
            className={tw(
              "flex h-9 w-36 items-center gap-2 rounded border border-gray-300 bg-white px-2 focus-within:border-primary-300 focus-within:ring-2 focus-within:ring-primary-100",
              error &&
                "border-error-300 focus-within:border-error-300 focus-within:ring-error-100",
              disabled && "cursor-not-allowed border-gray-300 bg-gray-50"
            )}
          >
            <span
              role="img"
              aria-label={
                isValidHexColor
                  ? `Selected category color ${color}`
                  : "Color preview"
              }
              className="size-4 shrink-0 rounded-sm border border-gray-400 shadow-sm ring-1 ring-gray-200"
              style={{ backgroundColor: isValidHexColor ? color : "#ffffff" }}
            />
            <input
              {...inputProps}
              id={name}
              name={name}
              type="text"
              value={color}
              onChange={handleColorChange}
              disabled={disabled}
              required={required}
              aria-label={label}
              className={tw(
                "min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-gray-900 outline-none placeholder:text-gray-500 focus:ring-0 disabled:cursor-not-allowed disabled:text-gray-500",
                inputClassName
              )}
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon="refresh"
            onClick={handleRefresh}
            disabled={disabled}
            className="size-9 shrink-0 p-1"
            aria-label="Generate new color"
            tooltip="Generate new color"
            data-test-id="generateRandomColor"
          />
        </div>
        {!hideErrorText && error ? (
          <div className="text-sm text-error-500">{error}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-end gap-1">
      <Input
        label={label}
        value={color}
        onChange={handleColorChange}
        className={className ?? "w-full min-w-[120px] lg:max-w-[120px]"}
        inputClassName={inputClassName}
        {...rest}
      />
      <Button
        icon="refresh"
        variant="secondary"
        size="sm"
        type="button"
        onClick={handleRefresh}
        className="cursor-pointer p-2"
        style={{
          backgroundColor: `${color}33`,
          color: iconColor,
        }}
        title="Generate random color (preview shows how badge will look)"
        data-test-id="generateRandomColor"
      />
    </div>
  );
};
