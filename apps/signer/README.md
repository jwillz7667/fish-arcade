# @reef/signer

Isolated Bitcoin payout signer. Runs in its own subnet, signs with the KMS hot key, enforces hard limits from its own config. CLAUDE.md: any change here requires human sign-off.

|          |                                     |
| -------- | ----------------------------------- |
| Spec     | §22.3, §22.4                        |
| Built in | Step 15 of `docs/BUILD_PLAYBOOK.md` |

Only the workspace manifest and TypeScript config exist so far. Scripts, source, and tests arrive with the step above.
