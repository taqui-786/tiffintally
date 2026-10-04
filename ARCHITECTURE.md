# TiffinDelta architecture

Status: backend implementation through Phase 2, October 4, 2026. See [core setup](docs/BACKEND_SETUP.md), [Phase 2 implementation/setup](docs/BACKEND_PHASE_2_SETUP.md) and [45-operation contracts](docs/openapi.json). Phase 1 Atlas initialization passed; live Google/owner checks, Gemma/JEV, TabPFN weights/inference, Sentry and deployment remain unverified. Starter UI is unchanged. Details below remain the earlier architecture baseline where superseded by current phase/setup notes.

This replaces the TapTutor architecture. The folder and package name remain `taptutor` until a separate rename is requested. [Product requirements](docs/PRODUCT.md) define acceptance criteria; [Backend Phase 1](docs/BACKEND_PHASE_1.md) and [Backend Phase 2](docs/BACKEND_PHASE_2.md) define current delivery order. Research documents are historical, not current specifications.

> **Current backend planning authority:** the two phase plans supersede conflicting details below. They specify Backboard's TypeScript SDK for Gemma/JEV, explicit JEV + TabPFN forecasting, Sentry Free and backend-only delivery. Atlas is preserved; the official MongoDB driver is recommended because Drizzle has no supported MongoDB adapter. Mastra is optional. Always use `/ponytail ultra` for code writing. No implementation or UI change is implied.

## Product boundary

Help one real home-food/tiffin seller reconcile recurring orders with last-minute customer messages and produce an accurate daily cooking/packing sheet. Models propose changes; the seller approves them; deterministic code calculates meals. This is not a recipe generator, food-safety system or full restaurant ERP.

MVP: one seller, one lunch service per day, one standard tiffin unit, roughly 10–20 customers, text-first intake, date-specific exceptions, review and printable sheets. Dish variants, extras and delivery routing are not silently inferred from unsupported requests.

## Existing stack and proposed additions

| Layer | Choice / status |
| --- | --- |
| App | Installed Next.js 16.3.8, App Router, root `app/` |
| UI | Installed React 19.2.8, TypeScript strict mode, Tailwind 4 |
| Components | Existing shadcn `base-rhea`, Base UI, `mist` tokens, lucide-react |
| Package manager | Existing pnpm 10.33.3 |
| Interpretation | Planned Gemma endpoint; exact model/runtime pending a real-input test |
| Classification | Planned TypeSafe JEV, server-side typed decisions |
| AI pipeline | Planned Mastra; not a separate general-purpose autonomous agent |
| Business persistence | Proposed MongoDB Atlas; not installed/provisioned |
| Hosting | Proposed Render app deployment; model runtime is a separate choice |
| Extensions | ElevenLabs voice input, Sentry Agent Tracing; optional TabPFN and Temporal later |

Preserve current fonts, theme, aliases and user setup changes. Do not reinitialize shadcn or replace Base UI. Add dependencies only when implementing their behavior. Read relevant installed Next.js docs before writing application code.

## Core decisions

1. **One application backend.** Next.js server routes/services handle business operations. No separate Express backend, queues, microservices or billing in the core slice.
2. **A hosted database is justified.** The seller needs durable customer plans, reviewed changes, audit history and the same packing state across devices. Browser storage is not the authoritative order book. A synthetic local fixture adapter can unblock the first slice but is not production persistence.
3. **Gemma interprets; JEV classifies; code calculates.** Neither model writes orders directly, authenticates a customer, sends messages or decides final quantities.
4. **Every operational change is reviewed.** High model confidence never bypasses approval, missing-field validation or conflict checks.
5. **Date-specific exceptions do not overwrite recurring plans.** Permanent changes are explicit and effective-dated; one-day changes expire by their date range.
6. **Approval is atomic and idempotent.** Repeated clicks/retries cannot count an order twice. Stale reviews must be refreshed.
7. **Printed sheets are immutable revisions.** Later approvals generate a visible amendment/new sheet, never silently rewrite a printed version.
8. **Privacy is explicit.** Hosted Gemma, JEV and voice services receive disclosed data. Do not claim full local/offline operation.

## End-to-end flow

1. Seller creates customer aliases and baseline schedules: weekdays, start date and integer tiffin quantity.
2. Seller pastes a bounded message, associates it with a customer and supplies/validates the original sent time. Unknown senders remain unresolved.
3. Store the source as a private record. Warn about suspected duplicates without merging unrelated messages.
4. Gemma extracts candidate facts, original date phrases, source spans and missing information into a validated schema.
5. JEV evaluates focused text plus relevant plan context: change type, whether wording explicitly replaces prior instructions, and clarity. Multi-intent inputs can produce several linked proposals; they are not forced into one guessed action.
6. Code resolves candidate dates using source time and seller timezone, validates quantities, computes affected services and previews before/after. Ambiguous dates require seller confirmation.
7. Seller edits, rejects, requests clarification or approves. Approval commits the change and audit receipt together; only committed approved data affects totals.
8. The board derives each customer's meal count for the selected service date. Seller finalizes a revision and prints a cooking total and per-customer packing list.
9. A later approved change displays its difference from the last finalized sheet and requires explicit late-change acknowledgement before a replacement revision is finalized.

Manual entry/review works when inference is unavailable. A real Gemma + JEV path must still be demonstrated for the intended submission; manual functionality is not evidence of completed AI integration.

## Business rules

- Default seller timezone: `Asia/Kolkata`, configurable at setup. Service dates are local `YYYY-MM-DD`; event timestamps also retain UTC instants. Do not derive the business date from the server's timezone.
- A recurring plan has effective dates, weekdays and nonnegative integer quantities. Zero means no meal. Reject negative/fractional values and values above the seller-configured limit.
- For a customer/date, start with the applicable recurring quantity (or zero); apply at most one active approved exception with an absolute replacement quantity. Sum customer quantities in code.
- One-off additions for an existing customer are explicit date overrides. A genuinely new customer needs manual identity setup before approval.
- Pauses use a confirmed bounded interval with quantity zero in the MVP. An open-ended pause or vague “resume as usual” stays unresolved until the seller supplies exact scope. A resume ends/replaces the relevant pause with a reviewed effective date; it does not guess a missing baseline.
- “Only one tomorrow” replaces the daily quantity; it is not an additional order. “One extra” needs the baseline and explicit conversion to an absolute reviewed quantity.
- Two active exceptions for the same customer/date cannot coexist. A later source timestamp alone does not establish precedence; seller-confirmed supersession does.
- Recurring plan changes are versioned with non-overlapping effective periods. Proposed edits preview effects on existing exceptions rather than silently deleting them.
- Calculation is independent of message ingestion order, inference availability and browser refresh. Draft/rejected/failed proposals contribute nothing.
- Cutoff is configurable. After cutoff or after a sheet has been finalized, require an explicit amendment preview and acknowledgement. Past finalized services are read-only for fulfillment in the MVP.
- Dietary/allergy wording is always flagged for direct seller handling. Do not certify a meal allergen-free or silently translate a dietary request into a different dish.
- Cooking totals are tiffin-unit totals, not ingredient weights or inventory deductions. Billing, payment status and refunds are out of scope.

## Domain and persistence contracts

Every business record is seller-scoped, runtime-validated and schema-versioned. IDs are server-validated; a submitted seller ID never grants access.

| Entity | Required information / invariant |
| --- | --- |
| Seller | Owner identity, timezone, lunch slot, cutoff, quantity limit, schedule revision |
| Customer | Stable ID, display alias, optional minimal packing note; names alone are not identity |
| Recurring plan | Customer, effective period, weekday quantities, revision/history |
| Source message | Source ID, customer association, sent/imported times, original text, content fingerprint; corrections preserve original evidence |
| Proposal | Source spans, candidate action/dates/quantity, unresolved fields, review status, draft revision, expected schedule revision |
| Approved exception | Customer, explicit inclusive service-date interval, absolute quantity, source/proposal references; no overlapping active exception |
| Approval receipt | Idempotency key, actor, approved payload hash, prior/result revisions, before/after facts, timestamp |
| Daily sheet | Seller/date/revision, committed schedule revision, immutable customer rows and total, finalization time, superseded-sheet reference |
| AI run | Status, source/draft revision, model IDs, prompt/schema versions, usage/latency and validation outcome; no raw content in telemetry |

Suggested collections follow these entities; avoid an unbounded embedded message/event array. IndexedDB may hold temporary unsent drafts only, never competing fulfillment truth. Optional image/audio originals require private blob storage with expiry; no such provider is selected or needed for text-first MVP.

### Consistent writes

- Within a database transaction, verify authorization, current proposal/draft version and the seller's expected schedule revision; validate overlapping exceptions; apply reviewed plan changes; record the approval receipt; update proposal status and increment schedule revision.
- Use the seller revision as the serialization point for schedule changes. It prevents two concurrent approvals both passing an overlap check. Unique indexes on seller-scoped idempotency keys enforce one committed effect. Reusing a key with different payload is an error; an identical retry returns its existing receipt.
- Finalization also checks/increments the seller revision in a transaction while saving the immutable sheet, so it cannot race silently with approvals. Unique seller/date/sheet-revision keys prevent duplicate snapshots.
- All authoritative mutations, including manual entries, must use the same services and validation. If transactions are unavailable in a development deployment, fail explicitly rather than split the write and leave totals/history inconsistent.
- Model calls happen outside database transactions. A delayed result is saved only against its matching draft revision; obsolete results cannot overwrite edits.
- Corrections are new reviewed records/supersessions, not destructive history rewrites. Reverting a change recomputes its impact against the current revision.

## AI contracts and failure behavior

**Gemma:** extract proposed facts and source references; draft a short clarification. Preserve verbatim source snippets. An image-capable model is required only when screenshot intake is added. Test the chosen model on the recipient's actual language; don't assume handwritten or Hinglish accuracy.

**JEV:** text/JSON input only. Choice labels include new order, one-off change, pause, resume, recurring-plan change, information and unclear. Noul can evaluate explicit replacement wording; Score uses an ordered clarity rubric, never meal quantities. Choice/Score confidence summarizes probabilities; Noul has no separate confidence field. Pin a tested model version and include unknown outcomes. All questions within one call are independent; a dependent step uses a later call.

**Mastra:** bounded pipeline for extraction, classification and validation. Application persistence owns the pending review and approval state; do not hold an HTTP request open while a seller reviews or add a second competing approval lifecycle. JEV can be wrapped as an explicit service/tool; don't assume a native provider integration exists.

Send only the relevant source and minimized plan facts, using customer aliases. Model state is untrusted data: embedded instructions cannot change application rules. No arbitrary tools, URLs, shell commands or executable model output. Classification is not proof that extracted facts match the original; independently validate source references and show them to the seller.

Missing credentials, timeout, malformed output, refusal, schema failure or disagreement must leave a visible failed/needs-review draft and retain manual editing. No hidden fixtures, fallback paid provider or automatic order application. Inference retries are explicit; application approval retries use receipts. Record pending/unknown provider outcomes rather than claiming success. Responses are private/non-cacheable.

## Planned module/API boundaries

| Location | Responsibility |
| --- | --- |
| `app/` | Seller board, intake/review, customers and sheet page composition |
| `components/ui/` | Existing shadcn primitives |
| `components/orders/` | Change cards, source panel, review forms and customer schedules |
| `components/sheets/` | Daily totals, packing rows, amendment preview and print view |
| `lib/domain/` | Pure schedule/date rules, conflict detection and sheet calculation |
| `lib/services/` | Authorized proposal approval, manual changes and sheet finalization |
| `lib/storage/` | Server-only database repositories and transaction boundary |
| `lib/ai/` | Server-only Gemma/JEV adapters, schemas and Mastra pipeline |
| `lib/demo/` | Clearly fictional fixtures for a separate demo mode |

Candidate endpoints: source intake, explicit analysis request, draft edit, approve/reject proposal, read daily board and finalize sheet. Exact route names are implementation details; every mutation requires authentication, validation and applicable revision/idempotency fields. Use server components for shells/read composition and client components for interactive review. No database or model credentials in client bundles or `NEXT_PUBLIC_*` variables.

Do not create empty folders for this table. Add each boundary with its first useful behavior. Totals must be testable without Next.js, a database, Mastra or network access.

## Deployment, security and operations

- Real seller data requires an authenticated owner session and seller-scoped authorization on every operation. Authentication provider/session mechanism is pending. No multi-tenant SaaS signup is required for the MVP.
- Public judging demo uses synthetic records, isolated from the seller's database. Keep paid generation disabled or controlled with access/spend limits. Never expose a shared mutable real order book.
- Start with bounded plain text (proposed 8,000 characters per message and 20 sources per import). Validate batch size and request bytes server-side; final limits depend on measured inference and hosting constraints.
- Add screenshot/audio formats only with MIME/decoded-size/duration checks, private storage and explicit retention/deletion. CSV export escapes spreadsheet formula-like values; never export secrets or hidden raw customer data.
- Disable raw prompts, receipts, audio, addresses and messages in logs, Sentry spans and session replay. Capture metadata such as latency, schema failures and human corrections instead.
- Configure retention before real-data intake. Explain that deletion/export must include owned sources, derivative records and optional blobs, subject to any retention the seller explicitly agrees to; don't promise indefinite audit storage.
- Render hosts the app; it does not automatically host a suitable Gemma runtime. A hosted server cannot access the seller's computer via its own `localhost`. Confirm endpoint reachability, cost and model license separately.
- No offline guarantee, automatic WhatsApp ingestion, automatic outbound messaging or background schedule is implemented. UI must distinguish committed saves from pending writes and show export/sheet revisions clearly.
- Responsive large controls, keyboard access, readable print output, visible focus and non-color-only status labels are required. Voice is an enhancement, not a substitute for usable text review.

## Partner scope and open decisions

Core proposed integrations: Gemma (interpretation), JEV (classification), Mastra (AI pipeline), MongoDB Atlas (business records), Render (deployment). JEV is user-requested, not a listed prize category. None is provisioned in this repository.

First extensions: ElevenLabs transcription and privacy-filtered Sentry Agent Tracing. Temporal is only justified later for durable cutoff/follow-up jobs with actual worker recovery/idempotency tests. TabPFN is conditional on useful historical data: predict additional late orders/cancellations at a fixed cutoff, not already-confirmed meal counts. Use chronological holdout, prediction-time features and a simple baseline; never claim real savings from synthetic data. Its Python runtime is additional infrastructure.

DigitalOcean and Thinking Machines/Tinker are excluded. Do not add another database, voice cloning, autonomous purchasing or unused partner SDKs for category count. Entire/Copilot categories require actual evidenced development use.

Pending before a real-user trial: recipient and consented examples, actual menu/unit rules, service weekdays/cutoff/timezone, language, model endpoint and JEV access, database/authentication setup, hosting budget and retention policy. Defaults above unblock design; they are not claims about the recipient's business.

## References

- [JEV research and original TiffinDelta proposal](docs/IDEAS_JEV_RESEARCH.md) — historical rationale, not current scope.
- [TypeSafe state](https://docs.typesafe.ai/concepts/state), [confidence](https://docs.typesafe.ai/confidence) and [limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
- [MongoDB atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/), [transactions](https://www.mongodb.com/docs/manual/core/transactions/) and [unique indexes](https://www.mongodb.com/docs/manual/core/index-unique/).
- [Mastra workflows](https://mastra.ai/docs/workflows/overview) and [Gemma documentation](https://ai.google.dev/gemma/docs).
- Installed Next.js guidance: `node_modules/next/dist/docs/`; see `AGENTS.md` before coding.
- [Official challenge](https://dev.to/challenges/hacktoberfest-weekend-2026-10-01).

JEV response contracts and MongoDB concurrency guidance were refreshed through Context7 for this documentation update. No provider request, database transaction or application behavior has been tested yet.
