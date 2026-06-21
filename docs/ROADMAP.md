# wa-hub-demo — Roadmap

Not promises — a list of where the project could go. PRs and issues welcome:
**[github.com/Noam13-w/wa-hub-demo](https://github.com/Noam13-w/wa-hub-demo)**.

## Anti-blocking (built-in)

Today the Hub is a thin, honest pipe — it does **not** ship the anti-ban heuristics commercial
providers (Green-API et al.) include. The recommended approach is to implement them in the code that
*calls* the API (see BUILD_GUIDE_HE.md §9, "שליחה בטוחה"). On the roadmap to optionally move these
into the Hub itself:

- [ ] Configurable random delay between sends (e.g. 3–15 s).
- [ ] Per-recipient rate limiting (≥30 s between messages to the same number; daily caps).
- [ ] "Warm-up" schedule for new numbers (ramp daily volume over the first ~2 weeks).
- [ ] Typing-indicator simulation before long messages.
- [ ] Single-tick stall detection → auto-pause + alert (the WhatsApp pre-ban warning sign).

## Multi-tenant / scale

- [ ] First-class multiple instances (per-number `instance_id` + port) behind one process or via containers.
- [ ] Optional shared store (replace the in-memory error/failure rings) for multi-instance dashboards.
- [ ] Horizontal/HA notes (multi-region, fallback).

## API surface

- [ ] Outbound webhook to Slack/Discord formats in addition to the generic signed POST.
- [ ] Message templating / scheduled sends.
- [ ] Richer group admin (create group, update subject/description, invite links).
- [ ] Media download endpoint for incoming media (currently surfaced as metadata only).

## Ops & DX

- [ ] Prometheus `/metrics` endpoint.
- [ ] First-class backup/restore command for `data/auth`.
- [ ] Docker image + compose example.
- [ ] Repeatable HTML/PDF build for `docs/BUILD_GUIDE_HE.md`.

---

Have a use case that's missing? Open an issue. Anti-ban, multi-tenant, and a Docker image are the
most-requested — those move first.
