// Shared spine for the four account-access forms. The pages keep their own submit
// flow — each one talks to a different endpoint and lands somewhere different — and
// pull the parts that must behave identically from here: which status note is on
// screen, how a field is marked wrong, and how a failed response becomes a state.
//
// Every string the reader sees is rendered server-side from the Studio collection,
// so nothing in this module writes copy. It only decides which pre-rendered note is
// visible, which is what keeps backend wording out of the Verdigris pages.

export type AuthStatusState =
  | "submitting"
  | "success"
  | "error"
  | "rate-limited"
  | "invalid"
  | "mismatch"
  | "verification-success"
  | "verification-invalid"
  | "";

export const createStatusBoard = (scope: ParentNode = document) => {
  const notes = [...scope.querySelectorAll<HTMLElement>("[data-auth-status]")];
  return (state: AuthStatusState) => {
    notes.forEach((note) => {
      note.hidden = note.dataset.authStatus !== state;
    });
  };
};

// A 429 is the only failure the reader can act on by waiting, and a 400 on a token
// route means the link itself is spent. Everything else stays the generic note.
export const failureState = (
  status: number,
  { invalidOnBadRequest = false } = {},
): AuthStatusState => {
  if (status === 429) return "rate-limited";
  if (invalidOnBadRequest && status === 400) return "invalid";
  return "error";
};

export type AuthField = {
  input: HTMLInputElement;
  error: HTMLElement | null;
  validate: (value: string) => boolean;
};

const setFieldValidity = (field: AuthField, valid: boolean) => {
  field.input.setAttribute("aria-invalid", valid ? "false" : "true");
  if (field.error) field.error.hidden = valid;
  return valid;
};

// Blank is left to the browser's own `required` handling so the reader is not told
// off for a field they have not reached yet.
export const checkField = (field: AuthField) =>
  setFieldValidity(field, !field.input.value || field.validate(field.input.value));

export const clearField = (field: AuthField) => setFieldValidity(field, true);

/**
 * Wires a field so it reports a problem on blur, and keeps reporting live once the
 * reader is already being told about one — the same rhythm as the western template,
 * where a mismatch appears as soon as the confirmation box has anything in it.
 */
export const bindField = (field: AuthField, extra: AuthField[] = []) => {
  field.input.addEventListener("blur", () => checkField(field));
  field.input.addEventListener("input", () => {
    if (field.input.getAttribute("aria-invalid") === "true") checkField(field);
    extra.forEach((dependent) => {
      if (dependent.input.value) checkField(dependent);
    });
  });
  return field;
};

/** Validates every field, focuses the first bad one, and reports whether to submit. */
export const submitIsAllowed = (fields: AuthField[]) => {
  const failed = fields.filter((field) => !setFieldValidity(field, field.validate(field.input.value)));
  failed[0]?.input.focus();
  return failed.length === 0;
};

// Deliberately forgiving: the server is the authority on whether an address exists,
// so this only catches the shapes that cannot be an address at all.
export const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export const isLongEnough = (value: string, minimum = 8) => value.length >= minimum;

export const requireInput = (scope: ParentNode, name: string) => {
  const input = scope.querySelector<HTMLInputElement>(`input[name='${name}']`);
  if (!input) throw new Error(`auth form is missing the ${name} field`);
  return input;
};

export const fieldErrorNote = (scope: ParentNode, name: string) =>
  scope.querySelector<HTMLElement>(`[data-field-error='${name}']`);
