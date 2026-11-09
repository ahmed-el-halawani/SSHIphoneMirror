# Agent-device reference for compact Simulator interaction

Inspected upstream: https://github.com/callstack/agent-device

Pinned reference commit: `093341a6040cc825763e05e0997bbeec7cdc085e`.

Reference checkout: `C:/Users/pc/.codex/references/agent-device`. It is outside the product repository and is not shipped.

Reviewed the MCP workflow guide, snapshot line formatter, snapshot diff implementation, reference tests, simulator AX bridge, and Apple runner documentation. The useful workflow is compact inspection, reference-based action, a settled diff, and explicit postcondition verification.

The implementation in this project is independently written Python over the existing IDB gRPC worker. No upstream runtime, native helper, dependency, or source file is copied into the product. It uses the Python standard library and retains the app's existing permissions, SSH trust, per-operation lock, hit test, and no-replay behavior.

The upstream project is MIT licensed, copyright 2026 Callstack. Any later source import must include its license and component-specific attribution. This implementation does not claim parity with agent-device's full runtime, replay engine, or platform coverage.
