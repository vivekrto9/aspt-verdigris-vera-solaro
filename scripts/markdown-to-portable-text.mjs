import { stdin, stderr, stdout } from "node:process";
import { markdownToPortableText } from "emdash/client";

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const markdown = Buffer.concat(chunks).toString("utf8").trim();

if (!markdown) {
  stderr.write("Markdown input is required.\n");
  process.exitCode = 1;
} else {
  try {
    const portableText = markdownToPortableText(markdown);
    if (!Array.isArray(portableText) || portableText.length === 0) {
      throw new Error("EmDash returned no Portable Text blocks.");
    }
    stdout.write(`${JSON.stringify(portableText)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown conversion error";
    stderr.write(`Portable Text conversion failed: ${message}\n`);
    process.exitCode = 1;
  }
}
