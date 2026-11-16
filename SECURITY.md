# Security policy

## Supported versions

Only the [latest release](https://github.com/PierreOliveira1/maestri-bridge/releases/latest) gets security fixes. Update to it before reporting a problem.

## Reporting a vulnerability

Don't open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/PierreOliveira1/maestri-bridge/security/advisories/new).

Include:

- what the problem is and what an attacker could do with it;
- the steps to reproduce it;
- your OS, editor and version, and Maestri version.

Never include real pairing codes or access tokens.

You'll get an answer within a week. Once the fix is released, the advisory is published and you're credited, unless you prefer not to be.

## Scope

Examples of what counts as a vulnerability:

- the access token or pairing code leaking, or being sent to a server whose security key doesn't match the pinned one;
- an agent link opening a file outside the folders open in the editor, or running a command;
- a message or note running code in the editor's webviews.

Problems in Maestri itself or in Wire should be reported to the Maestri team.
