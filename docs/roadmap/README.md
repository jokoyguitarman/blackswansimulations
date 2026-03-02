# Roadmap — Specifics per step

This folder holds the **specifics per step** for the implementation roadmap. The master list and overview live in [../IMPLEMENTATION_ROADMAP.md](../IMPLEMENTATION_ROADMAP.md).

---

## Structure

One markdown file per step, named:

- `step-NN-<short-name>.md`

Examples: `step-01-database.md`, `step-02-environmental-state-service.md`, … `step-08-cleanup.md`.

Each step doc is linked from the master roadmap.

---

## Suggested template for step docs

When you or the agent fills in a step, include:

- **Short description** — What this step achieves.
- **Files to create or modify** — Paths and brief purpose.
- **Key structures or contracts** — Data shapes, APIs, config.
- **Acceptance criteria** — How to know the step is done.
- **Depends on** — Previous steps that must be done first.

Details can be filled in when implementing that step.

---

## Reference

- Design and diagrams: [../ENVIRONMENTAL_HYBRID_INJECT_DESIGN.md](../ENVIRONMENTAL_HYBRID_INJECT_DESIGN.md)
- Master roadmap: [../IMPLEMENTATION_ROADMAP.md](../IMPLEMENTATION_ROADMAP.md)
- High-level phases and Type A/B handling: [../INJECT_ENGINE_DEVELOPMENT_PLAN.md](../INJECT_ENGINE_DEVELOPMENT_PLAN.md)
