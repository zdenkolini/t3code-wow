@AGENTS.md

## Fork notes (zdenkolini/t3code-wow)

This file exists only on the fork's `main`. Never include it, or anything under `docs/agents/`, in a PR to `ryanrhughes/t3code-wow`.

- `main`: upstream plus fork-only tooling (this file, agent-skills config).
- `zdenkolini/*` feature branches are cut from `upstream/main` and carry only work meant for upstream. Merge them into `main` to run them together with the tooling.
- Also fork-only: `GLOSSARY.md`, `docs/adr/` and `docs/agents/`. Nothing about this workflow (issues, specs, labels, skills config) goes to `ryanrhughes/t3code-wow`; only the Windows code changes do.

## Agent skills

### Issue tracker

GitHub Issues on zdenkolini/t3code-wow (never upstream), via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical names, unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
