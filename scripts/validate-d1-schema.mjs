import { validateD1Schema } from "./d1-schema-contract.mjs";

const failures = validateD1Schema();

if (failures.length > 0) {
  console.error("D1 schema contract check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("D1 schema contract check passed");
