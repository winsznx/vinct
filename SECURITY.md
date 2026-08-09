# Security

## Reporting

Open a [private security advisory](https://github.com/winsznx/vinct/security/advisories/new).
Please do not open a public issue for anything exploitable.

Useful in a report: what an attacker gains, the accounts and instructions involved, and a
sequence that reproduces it. A LiteSVM test under `crates/vinct-program-tests` is the fastest way
to make a finding undeniable, and the existing files there show the shape.

## Scope

This is a Devnet research build. There is no mainnet deployment and no funds at risk.

In scope: the three programs, the canonical type layer, the reference model, the settlement
monitor, the standalone verifier, the client, and the web application.

Particularly interesting:

- any path where VINCT gains authority over a protocol's contracts
- any path where a member learns another member's decision, or that they answered
- any path where a certificate is produced without a covenant reaching its threshold
- any path where a bounded action exceeds what its protocol armed
- any path where settlement is reported without the effects being observed

Out of scope: MagicBlock's own infrastructure, Solana itself, wallet extensions, and the
operational limitations already recorded in
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md).

## Before reporting

[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) documents the trust boundaries and a list of
failures already found and fixed, each with the gate it left behind.
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) is explicit about what is deliberately not
claimed, including the limits of the TEE attestation.

A finding that one of those documents already describes is still worth sending if you think the
write-up understates it.
