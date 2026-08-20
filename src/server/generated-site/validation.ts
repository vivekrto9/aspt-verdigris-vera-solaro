import { errorResponse } from "./responses.ts";
import type { JsonObject } from "./request.ts";

const hasText = (value: unknown) =>
  typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;

export const requireFields = (
  payload: JsonObject,
  feature: string,
  fields: string[],
) => {
  const missingField = fields.find((field) => !hasText(payload[field]));

  if (!missingField) {
    return undefined;
  }

  return errorResponse(feature, `Missing required field: ${missingField}`);
};

export const requireCoordinates = (payload: JsonObject, feature: string) => {
  if (!hasText(payload.latitude ?? payload.lat) || !hasText(payload.longitude ?? payload.lon)) {
    return errorResponse(feature, "Missing required fields: latitude and longitude");
  }

  return undefined;
};
