import { detectWorkflowMode, workflowPaths } from "./generated-site-contract-assertions.mjs";

export { detectWorkflowMode, workflowPaths };

export const isGeneratedSiteMode = (root) => detectWorkflowMode(root) === "generated-site";
export const isTemplateSourceMode = (root) => detectWorkflowMode(root) === "template-source";

export const deploymentWorkflowPaths = (root) =>
  isGeneratedSiteMode(root)
    ? [workflowPaths.installedPreview, workflowPaths.installedProduction]
    : [
        workflowPaths.generatedPreviewSeed,
        workflowPaths.generatedProductionSeed,
      ];
