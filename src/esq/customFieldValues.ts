type RequestedCustomFieldValue = {
  custom_field_id: number;
  value: unknown;
};

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

export function buildNewCustomFieldValues(value: unknown): Array<Record<string, unknown>> {
  return normalizedRequests(value).map(({ custom_field_id, value: fieldValue }) => ({
    custom_field: { id: custom_field_id },
    value: String(fieldValue),
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
      ? { id: existingId, value: String(value) }
      : { custom_field: { id: custom_field_id }, value: String(value) };
  });
}
