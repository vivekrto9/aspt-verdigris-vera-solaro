# OpenHands Playbook

Use this playbook when an AI agent edits this generated Vera Solaro site.

## Code Changes

Use normal file edits for layout, components, styles, routes, tests, schema migrations, and integrations. Code-only edits should not re-bootstrap all content when the generated-site bootstrap state is current.

Workflow time should be read as separate phases:

- AI edit time.
- Preview workflow time.
- Finalization and callback time.

Do not infer content mutation from a successful code deploy. Release review should show code and content as separate artifacts.

## Content Changes

Public copy and SEO should be changed through EmDash tools:

- Content Studio.
- EmDash MCP.
- EmDash REST/admin APIs.

Do not raw-update EmDash content tables with SQL for normal content edits. The generated site records content revisions at the EmDash mutation layer, then AstroPages captures deterministic content snapshots for release review.

Content-only changes are valid release candidates. They do not need fake code edits.

## Release Review

AstroPages release review may show:

- Code-only update.
- Content-only update.
- Mixed code and content release.
- Media changes when media manifests are implemented.

Approval locks the current content snapshot. If content changes after approval, the latest release candidate must be reviewed again before production publish.

## Guardrails

- Keep generated-site GitHub variables generic.
- Keep generated-site Worker deploys on callback-token secrets.
- Do not log secrets, session cookies, SSO tokens, raw content snapshot payloads, or customer credentials.
- Keep public render paths read-only.
