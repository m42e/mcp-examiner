import { AlertTriangle, X } from "lucide-react";

function compactError(error: string, maxLength = 150) {
  const oneLine = error.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength
    ? `${oneLine.slice(0, maxLength).trimEnd()}...`
    : oneLine;
}

export function ConnectionToast({
  error,
  onDismiss,
}: {
  error: string;
  onDismiss: () => void;
}) {
  return (
    <div className="connection-toast" role="alert">
      <AlertTriangle size={16} />
      <span>{compactError(error)}</span>
      <button
        className="icon-button"
        type="button"
        aria-label="Dismiss connection error"
        onClick={onDismiss}
      >
        <X size={15} />
      </button>
    </div>
  );
}
