import { tw } from "~/utils/tw";
import { Button } from "../shared/button";
import { ButtonGroup } from "../shared/button-group";

interface ViewOption {
  label: string;
  value: string;
}

interface ViewButtonGroupProps {
  views: ViewOption[];
  currentView: string;
  onViewChange: (view: string) => void;
  className?: string;
  activeClassName?: string;
  size?: "xs" | "sm" | "md";
}

export const ViewButtonGroup = ({
  views,
  currentView,
  onViewChange,
  className = "", // Additional styling
  activeClassName = "",
  size = "sm",
}: ViewButtonGroupProps) => {
  const disabledButtonStyles =
    "cursor-not-allowed pointer-events-none bg-gray-50 text-gray-800";

  return (
    <ButtonGroup className={className}>
      {views.map(({ label, value }) => (
        <Button
          type="button"
          key={value}
          variant={"secondary"}
          size={size}
          onClick={() => onViewChange(value)}
          className={tw(
            currentView === value
              ? `${disabledButtonStyles} ${activeClassName}`
              : ""
          )}
          disabled={currentView === value}
        >
          {label}
        </Button>
      ))}
    </ButtonGroup>
  );
};
