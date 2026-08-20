export function databaseNameForEnvironment(config, environment, binding = "DB") {
  const section = config?.env?.[environment];
  if (!section) {
    throw new Error(`Wrangler config is missing environment ${environment}.`);
  }
  const database = section.d1_databases?.find(
    (candidate) => candidate?.binding === binding,
  );
  const databaseName = database?.database_name;
  if (!databaseName || typeof databaseName !== "string") {
    throw new Error(
      `Wrangler config environment ${environment} is missing D1 binding ${binding}.`,
    );
  }
  return databaseName;
}
