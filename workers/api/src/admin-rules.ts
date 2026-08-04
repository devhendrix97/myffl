import { ApiException } from "./http";

export function pointsMilli(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1000) {
    throw new ApiException(400, "invalid_points", "Corrected points must be a number between -1000 and 1000.");
  }
  const milli = Math.round(value * 1000);
  if (Math.abs(value * 1000 - milli) > 0.000001) {
    throw new ApiException(400, "invalid_points_precision", "Use no more than three decimal places.");
  }
  return milli;
}

export function requiredReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < 4 || reason.length > 500) {
    throw new ApiException(400, "reason_required", "Enter a reason between 4 and 500 characters.");
  }
  return reason;
}
