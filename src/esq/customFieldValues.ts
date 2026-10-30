import { clioGet } from "../utils/clioClient.js";

type RequestedCustomFieldValue = {
  custom_field_id: number;
  value: unknown;
};

export type CustomFieldParentType = "Contact" | "Matter";

const MAX_CUSTOM_FIELD_LOOKUP_CONCURRENCY = 4;

type CustomFieldDefinition = {
  id: number;
  name: string;
  field_type: string;
  parent_type: CustomFieldParentType;
  picklist_options?: Array<{ id: number; option: string }>;
};

function apiCustomFieldValue(value: unknown): unknown {
  return typeof value === "boolean" ? value : String(value);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isIsoTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))?$/.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59 &&
    (match[3] === undefined || Number(match[3]) <= 59) &&
    (match[4] === undefined || (Number(match[4]) <= 23 && Number(match[5]) <= 59));
}

function validateScalarValue(value: unknown, fieldType: string): void {
  const stringValue = typeof value === "string" ? value : null;
  switch (fieldType) {
    case "text_line":
      if (stringValue === null || /[\r\n]/.test(stringValue) || stringValue.length > 255) {
        throw new Error("text_line custom field values must be single-line strings of at most 255 characters.");
      }
      return;
    case "text_area":
      if (stringValue === null || stringValue.length > 64_000) {
        throw new Error("text_area custom field values must be strings of at most 64000 characters.");
      }
      return;
    case "numeric": {
      const parsed = typeof value === "number" ? value : stringValue !== null && /^\d+$/.test(stringValue) ? Number(stringValue) : NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("numeric custom field values must be non-negative whole numbers.");
      return;
    }
    case "currency": {
      const serialized = typeof value === "number" ? String(value) : stringValue;
      const parsed = serialized !== null && /^-?\d+(?:\.\d{1,2})?$/.test(serialized) ? Number(serialized) : NaN;
      if (!Number.isFinite(parsed)) {
        throw new Error("currency custom field values must be finite monetary amounts with at most two decimal places.");
      }
      return;
    }
    case "date":
      if (stringValue === null || !isCalendarDate(stringValue)) throw new Error("date custom field values must be real ISO dates (YYYY-MM-DD).");
      return;
    case "time":
      if (stringValue === null || !isIsoTime(stringValue)) throw new Error("time custom field values must be valid ISO times.");
      return;
    case "checkbox":
      if (typeof value !== "boolean") throw new Error("checkbox custom field values must be booleans.");
      return;
    case "email":
      if (stringValue === null || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stringValue)) throw new Error("email custom field values must be valid email addresses.");
      return;
    case "url":
      if (stringValue === null) throw new Error("url custom field values must be valid URLs.");
      try {
        new URL(stringValue);
      } catch {
        throw new Error("url custom field values must be valid URLs.");
      }
      return;
    default:
      throw new Error(`Unsupported custom field type: ${fieldType}.`);
  }
}

function normalizedRequests(value: unknown): RequestedCustomFieldValue[] {
  if (!Array.isArray(value)) throw new Error("Malformed requested custom_field_values.");
  const seen = new Set<number>();
  return value.map((entry) => {
    const customFieldId = entry?.custom_field_id;
    if (!Number.isInteger(customFieldId) || customFieldId <= 0 || !("value" in entry)) {
      throw new Error("Malformed requested custom field value.");
    }
    if (seen.has(customFieldId)) throw new Error("A custom field may be supplied only once per mutation.");
    seen.add(customFieldId);
    return { custom_field_id: customFieldId, value: entry.value };
  });
}

function referenceId(value: unknown, fieldType: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldType} custom field values must be positive integer IDs.`);
  }
  return parsed;
}

function validateDefinition(value: unknown, expectedId: number, parentType: CustomFieldParentType): CustomFieldDefinition {
  const definition = value as Partial<CustomFieldDefinition> | undefined;
  if (definition?.id !== expectedId || typeof definition.name !== "string" ||
      typeof definition.field_type !== "string" ||
      (definition.parent_type !== "Contact" && definition.parent_type !== "Matter")) {
    throw new Error(`Custom field ${expectedId} returned an invalid definition.`);
  }
  if (definition.parent_type !== parentType) {
    throw new Error(`Custom field ${expectedId} does not belong to ${parentType} records.`);
  }
  return definition as CustomFieldDefinition;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function resolveCustomFieldValueDetails(
  requested: unknown,
  parentType: CustomFieldParentType,
): Promise<Array<Record<string, unknown>>> {
  const requests = normalizedRequests(requested);
  const referenceCache = new Map<string, Promise<Record<string, unknown>>>();

  return mapWithConcurrency(requests, MAX_CUSTOM_FIELD_LOOKUP_CONCURRENCY, async ({ custom_field_id, value }) => {
    const response = await clioGet(`/custom_fields/${custom_field_id}.json`, {
      fields: "id,name,field_type,parent_type,picklist_options{id,option}",
    });
    const definition = validateDefinition(response?.data, custom_field_id, parentType);
    const detail: Record<string, unknown> = {
      custom_field: {
        id: definition.id,
        name: definition.name,
        field_type: definition.field_type,
        parent_type: definition.parent_type,
      },
      value: apiCustomFieldValue(value),
    };

    if (definition.field_type === "picklist") {
      const id = referenceId(value, "picklist");
      const option = definition.picklist_options?.find((candidate) => candidate.id === id);
      if (!option || typeof option.option !== "string") {
        throw new Error(`Picklist option ${id} does not belong to custom field ${custom_field_id}.`);
      }
      detail.resolved_value = { id: option.id, label: option.option };
    } else if (definition.field_type === "contact" || definition.field_type === "matter") {
      const id = referenceId(value, definition.field_type);
      const key = `${definition.field_type}:${id}`;
      let resolution = referenceCache.get(key);
      if (!resolution) {
        resolution = definition.field_type === "contact"
          ? clioGet(`/contacts/${id}.json`, { fields: "id,name,type" }).then((result) => {
              if (result?.data?.id !== id || typeof result.data.name !== "string") {
                throw new Error(`Contact ${id} could not be validated for custom field ${custom_field_id}.`);
              }
              return { id, label: result.data.name, type: result.data.type };
            })
          : clioGet(`/matters/${id}.json`, { fields: "id,display_number,description,status" }).then((result) => {
              if (result?.data?.id !== id || typeof result.data.display_number !== "string") {
                throw new Error(`Matter ${id} could not be validated for custom field ${custom_field_id}.`);
              }
              return {
                id,
                label: result.data.display_number,
                description: result.data.description,
                status: result.data.status,
              };
            });
        referenceCache.set(key, resolution);
      }
      detail.resolved_value = await resolution;
    } else {
      validateScalarValue(value, definition.field_type);
    }

    return detail;
  });
}

export function buildNewCustomFieldValues(value: unknown): Array<Record<string, unknown>> {
  return normalizedRequests(value).map(({ custom_field_id, value: fieldValue }) => ({
    custom_field: { id: custom_field_id },
    value: apiCustomFieldValue(fieldValue),
  }));
}

export function buildUpdatedCustomFieldValues(
  requested: unknown,
  current: unknown,
): Array<Record<string, unknown>> {
  if (current !== undefined && current !== null && !Array.isArray(current)) {
    throw new Error("Malformed current custom_field_values response.");
  }

  const existingByDefinition = new Map<number, string | null>();
  for (const entry of (current ?? []) as any[]) {
    const definitionId = entry?.custom_field?.id;
    if (!Number.isInteger(definitionId) || definitionId <= 0) {
      throw new Error("Malformed current custom field value.");
    }
    if (existingByDefinition.has(definitionId)) {
      throw new Error("Duplicate current custom field definition.");
    }
    if (entry.id !== null && entry.id !== undefined &&
        (typeof entry.id !== "string" || !entry.id.trim())) {
      throw new Error("Malformed current custom field value ID.");
    }
    existingByDefinition.set(definitionId, entry.id ?? null);
  }

  return normalizedRequests(requested).map(({ custom_field_id, value }) => {
    const existingId = existingByDefinition.get(custom_field_id);
    return existingId
      ? { id: existingId, value: apiCustomFieldValue(value) }
      : { custom_field: { id: custom_field_id }, value: apiCustomFieldValue(value) };
  });
}
