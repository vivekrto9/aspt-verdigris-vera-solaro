export type ContentReleaseMutationAction = "saveDraft" | "publish";

const localContentStudioHostnames = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

const contentReleaseMutationActionKey = Symbol.for(
  "astropages.content-release-mutation-action",
);

export const setContentReleaseMutationAction = (
  locals: object,
  action: ContentReleaseMutationAction,
) => {
  (locals as Record<PropertyKey, unknown>)[contentReleaseMutationActionKey] = action;
};

export const getContentReleaseMutationAction = (
  locals: object,
): ContentReleaseMutationAction | undefined => {
  const action = (locals as Record<PropertyKey, unknown>)[contentReleaseMutationActionKey];
  return action === "saveDraft" || action === "publish" ? action : undefined;
};

export const shouldSkipLocalContentReleaseLog = (
  request: Request,
  isDevelopmentRuntime: boolean,
) =>
  isDevelopmentRuntime &&
  localContentStudioHostnames.has(new URL(request.url).hostname);
