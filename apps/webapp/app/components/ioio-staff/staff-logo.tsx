type StaffLogoProps = {
  compact?: boolean;
  large?: boolean;
};

/** Shared IOIO artwork and container used by Staff navigation and error pages. */
export function StaffLogo({ compact = false, large = false }: StaffLogoProps) {
  return (
    <div
      data-testid="ioio-staff-logo"
      className={`flex aspect-[316/129] items-center justify-center overflow-hidden rounded-2xl bg-red-800 p-1.5 ${
        large ? "w-40" : compact ? "w-24" : "w-32"
      }`}
    >
      <img
        src="/static/images/ioio-logo-white.png"
        alt="IOIO Lab"
        className="size-full object-contain"
      />
    </div>
  );
}
