# LPU WhatsApp Food Pre-Booking System — Engineering Handoff

**Purpose:** a complete handoff so a new engineer (or Claude session) can pick this project up with zero prior context. Read this whole document before touching code. The previous version of this file described an early, local-only, Groq-powered prototype — that phase is over. Everything below reflects the system as actually deployed today.

**Last updated:** 2026-08-09 (Stall Rating & Feedback, Offers & Promotions Engine, AI Business Assistant, an Advanced Analytics Platform, an AI Demand Forecasting System, a production security hardening pass, and a Vitest-based automated testing framework shipped this session — see §4.9–§4.15).

---

# 1. What this is, in one paragraph

A food pre-booking system for LPU campus food stalls where the entire student experience happens inside WhatsApp — no app, no website. A Gemini-powered AI handles free-text conversation (search, cart, checkout) while a deterministic button-first wizard (Reply Buttons + List Messages) handles structured navigation (Home → Browse Stalls → location → stall → category → item → cart, plus a "More" menu and a personalized "For You" suggestion flow). Stall owners manage a live order queue and see accountability metrics on a web dashboard; a Super Admin manages stalls, owners, and the menu category taxonomy on the same dashboard. Both the backend (Docker web service) and dashboard (static site) are deployed on Render, auto-deploying from `master`.

---

# 2. Current deployment (live right now)

| | |
|---|---|
| Backend | https://lpu-food-ordering.onrender.com (Render service `srv-d9mfn161egvs73e3dk2g`, Docker) |
| Dashboard | https://lpu-food-dashboard.onrender.com (Render static site `srv-d9nji8m417fc73dgqctg`) |
| Health check | `GET /health` → `{"status":"ok"}` (no DB connectivity check) |
| Database | Supabase Postgres, **Session Pooler** connection string (direct connection is IPv6-only and unreachable from Render) |
| Repo | https://github.com/rajatrajan03/lpu-food-ordering, branch `master`, auto-deploy on push |
| WhatsApp app | Meta app "Food AI Chatbot", App ID `1395400689115041`, WABA ID `1030552156036850` |

**Deploying:** push to `master` triggers Render's auto-deploy for both services. To trigger manually (e.g. after only changing an env var): `POST https://api.render.com/v1/services/<id>/deploys` with the Render API key. Poll `GET .../deploys?limit=1` for status until `"live"`.

**Database migrations:** hand-written SQL only, applied via `npx prisma migrate deploy` against the real `DATABASE_URL`. **Never use `prisma migrate diff --shadow-database-url` pointed at production** — this wiped the production database twice earlier in this project's history (all real student/order data from before that incident is permanently gone; everything since was re-imported from the source spreadsheet). This is a hard, standing rule, not a suggestion.

---

# 3. The recurring operational chore: WhatsApp access token

The WhatsApp access token in use is a **short-lived `USER`-type token** (~1–2 hour expiry from Meta's test setup), not a permanent System User token. It has been manually regenerated and pushed to Render dozens of times over the course of this project. **This is the single biggest recurring friction point.**

**The fix that has never been completed:** generate a permanent token via Meta Business Settings → System Users → create a system user → assign it to the WhatsApp Business Account with `whatsapp_business_messaging`/`whatsapp_business_management` permissions → generate a token with no expiry. This has been explained to the project owner multiple times but a permanent token has not yet been created.

**Until then, the routine every time the bot stops responding:**
1. Verify the new token: `GET https://graph.facebook.com/v21.0/debug_token?input_token=<token>&access_token=<token>` — confirm `is_valid: true` and check `expires_at`.
2. Update Render: `PUT https://api.render.com/v1/services/srv-d9mfn161egvs73e3dk2g/env-vars/WHATSAPP_ACCESS_TOKEN` with `{"value": "<token>"}`.
3. Update `backend/.env` locally to match (for local dev/testing).
4. Trigger a redeploy (env var changes don't hot-reload).
5. Poll until live, confirm `/health`.

---

# 4. Architecture

## 4.1 Request flow

```
Student (WhatsApp) → Meta Cloud API → POST /webhook/whatsapp
                                          ↓ (serialized per phone number — see 4.4)
                                    handleIncomingMessage()
                                          ↓
                    onboarding gate → smartFlow ("For You" wizard) → browseFlow (button nav)
                                          ↓ (falls through if none apply / unmatched input)
                              Gemini tool-calling loop (free-text search/cart/checkout)
                                          ↓
                              executeTool() dispatches to Prisma-backed services
                                          ↓
                                    Postgres (Supabase)

Stall Owner / Super Admin (browser) → React dashboard (Render static site)
                                          ↓ fetch() with Bearer JWT
                                 Express API routes (Render backend)
                                          ↓
                                 Same Prisma services + Postgres

services/slaMonitor.ts → in-process setInterval (60s) → auto-reject / SLA-violation / no-show sweeps
```

One backend, one database, two client surfaces (WhatsApp webhook, dashboard REST API), plus one in-process background sweep. No separate AI service, no queue/worker infrastructure — everything is one Node process.

## 4.2 `handleIncomingMessage` priority order (important — this is the actual control flow)

In `ai/conversationEngine.ts`, for every inbound message:

1. **Onboarding gate** — if the student has no `registrationNumber`, ask for it (stored, never validated). If no `name`, ask for it — rejects greetings/filler ("hi", "ok", "yes", etc. — see `studentService.isPlausibleName`) with a re-prompt instead of saving garbage.
2. **`session.smartFlow`** — mid-flight "For You" wizard (confirm usual order → pick pickup location → pick a matching stall → fill cart). Takes priority over everything if set.
3. **`session.browseFlow`** — mid-flight button navigation (Home/Browse Stalls/More). Handles the tap/text; if unmatched, clears the flow and falls through.
4. **Home-button/More-button/post-order-button ids** — `home_browse`, `home_foryou`, `home_more`, `post_track`, `post_cancel:<id>`, `order_status:<id>`.
5. **`GREETING_PATTERN`** (`hi|hello|hey|...`) — sends the Home screen (3 Reply Buttons).
6. **Fallback: Gemini tool-calling loop** — free text goes here. 11 tools (`list_stalls`, `search_menu`, `view_cart`, `add_to_cart`, `remove_from_cart`, `get_pickup_slots`, `place_order`, `get_order_status`, `cancel_order`, `get_order_history`, `repeat_last_order`).

**Session state** (`Student.sessionState`, a JSON column) holds: `cart`, `activeStallId`, bounded `knownStalls`/`knownItems`/`knownSlots` name→id lookup maps (so the AI can reference a real id without replaying full tool results), a short `recentMessages` window, and the optional `smartFlow`/`browseFlow` wizard states.

**⚠️ `getSessionState()` in `conversationEngine.ts` explicitly whitelists every field it reconstructs from the raw JSON column.** Adding a new field to `SessionState` (in `tools.ts`) without also adding it here means it gets **silently dropped on every reload** — this exact bug has happened twice (`smartFlow`, then almost again with `browseFlow`). `getSessionState` is exported specifically so other modules (e.g. `slaMonitor.ts`'s proactive alternative-stall suggestion) reuse it instead of re-deriving a second, divergent whitelist.

## 4.3 Button-first navigation (`ai/browseFlow.ts`)

A deterministic state machine (`session.browseFlow.current`/`.stack`), not AI-driven, because button/list contents must reflect exact DB state:

- **Home**: 🍽 Browse Stalls / ✨ For You / ☰ More (3 Reply Buttons).
- **Browse Stalls**: location List Message → stall List Message → category (Reply Buttons if ≤3, List Message if more) → item List Message (name/price) → item detail (List Message: qty +/−, Add To Cart, Continue Shopping, Back, Home).
- **Add To Cart** → sends explicit **Add More / View Cart / Checkout** Reply Buttons (not a silent drop back into the item list — this was a real UX bug, see §6).
- **Checkout** button is **deterministic** — calls `menuService.getAvailablePickupSlots` directly and sends the pickup-slot List Message. It does **not** route through the AI as free text — an earlier version did, and the AI occasionally misread the checkmark-emoji button title as an unrelated food search (see §6).
- **More**: View Cart / Track Order / Recent Orders / Favorite Stalls / My Profile / Help.
- Any unmatched tap/text clears `browseFlow` and falls through to the Gemini loop, so free-text search always still works mid-browse.
- A cart/stall conflict (adding from a different stall) shows **Clear & Add** / **Cancel** buttons — never a dead-end warning with no way forward.

## 4.4 Per-phone-number message serialization

`routes/webhook.ts` chains each phone number's `handleIncomingMessage` calls through an in-memory `Map<string, Promise>` queue so overlapping messages from the same student are processed **strictly one at a time, in arrival order**. Different students still process fully in parallel.

This exists because a real bug occurred: a student sending 2–3 messages in quick succession (e.g. "Hello" / "Hi" / "Hi") triggered fully concurrent `handleIncomingMessage` calls that raced on reads/writes to the same `Student` row, silently skipping onboarding steps and once corrupting a real student's name to the literal string `"Hi"`. Never remove this queue without replacing it with an equivalent lock.

## 4.5 Order SLA & Accountability system

New `Order` fields (see schema in §5): `acceptDeadline`, `acceptedAt`, `autoRejected`, `readyAt`, `slaViolation`/`slaViolationMinutes`, `noShow`/`noShowAt`. New `Stall.pickupGraceMinutes` (nullable, per-stall override).

- **Accept deadline**: every order gets `placedAt + 10 minutes` (`orderService.ACCEPT_DEADLINE_MINUTES`) at creation.
- **`services/slaMonitor.ts`** runs a 60-second in-process sweep (`setInterval`, started from `server.ts` — no new infra, matches the existing single-process architecture):
  - `sweepUnansweredOrders` — orders past their accept deadline still `placed` get auto-rejected (`transitionOrderStatus(..., { auto: true })`), the pickup slot is released, the student is notified, then sent a **tappable list of nearby alternative stalls** (same `stall:<id>` scheme as Browse Stalls — tapping one primes `browseFlow` to continue shopping there, reusing the existing flow rather than dead-ending). `autoRejected` is a distinct flag from an owner-initiated reject, so it's never counted against the owner.
  - `sweepSlaViolations` — orders accepted/preparing whose pickup slot has already ended without being marked ready get flagged `slaViolation: true` with the delay in minutes. Also computed synchronously the moment an order *is* marked ready late, inside `transitionOrderStatus`.
  - `sweepNoShows` — ready orders not collected within pickup-slot-end + grace period (stall-configurable via `Stall.pickupGraceMinutes`, default `orderService.DEFAULT_PICKUP_GRACE_MINUTES = 10`) are auto-closed to `completed` with `noShow: true` — excluded from "usual order" preference learning, never counted against the owner.
- **Owner Dashboard** shows 5 stat cards under "Order SLA & Accountability": Avg. Acceptance Time, Missed Acceptance Deadlines, SLA Violations, On-Time Preparation Rate, Customer No-Shows (`GET /api/owner/stalls/:id/sla-metrics`, also accepts `?date=YYYY-MM-DD`).

**A known limitation to be aware of:** this sweep is a plain `setInterval` in one Node process. It is correct for the current single-instance Render deployment. If this service is ever scaled to multiple instances, the sweep would need a distributed lock (e.g. a DB-level advisory lock) or it would double-process — not currently a problem, but don't forget it if scaling comes up.

## 4.6 Order lifecycle

```
placed → accepted → preparing → ready → completed
placed → rejected (owner-initiated, or system auto-reject after 10 min)
placed/accepted → cancelled (student-initiated, via cancelOrder(), not the transition map)
ready → completed (also reached via the no-show auto-close, flagged noShow: true)
```

`ALLOWED_TRANSITIONS` in `orderService.ts` gates owner-initiated transitions. `CANCELLABLE_STATUSES = ["placed", "accepted"]` gates student cancellation, a separate function. Pickup slot booking is atomic: `placeOrder()` runs in a `$transaction`, incrementing `bookedCount` via `updateMany({ where: { bookedCount: { lt: maxCapacity } } })` — 0 rows affected means the slot just filled, and the whole order creation aborts.

**Random customer-facing order IDs**: `Order.displayId` (`ORD-XXXXXXXX`, 8 chars from a 36-symbol alphabet via `crypto.randomInt`), deliberately decoupled from `id`/sequence/`placedAt` so it never leaks order volume or timing. The AI, WhatsApp notifications, and the dashboard all use `displayId` — the raw UUID `id` is only used internally. `cancelOrder` accepts either identifier (button-tap paths already have the real `id`; the AI path only ever sees `displayId`).

**Order status notifications** (`orderService.notifyStudentOfStatus`) now send the **full detail block** (stall, items, total, pickup time) on every status change, not just a one-line status phrase — with more than one order in flight, a bare "Accepted!" doesn't say which order. `notifyStudentOfStatus` is `await`ed by its caller (not fire-and-forget) so any follow-up message (e.g. the alternative-stalls list after an auto-reject) is guaranteed to send after it, in the right order — this was a real bug (see §6).

**Known gap:** `STATUS_LINES` has no entry for `"completed"` — no WhatsApp notification is sent when an order is marked completed. Not yet fixed.

## 4.7 Pickup slots & timezone handling

Pickup slots are real `PickupSlot` rows (`slotDate` DATE + `startTime`/`endTime` TIME, stored separately), generated by `services/slotGenerator.ts` — **no cron wired up**, must be run manually (`npm run generate:slots -- <days>`) or a stall runs out of bookable slots.

**The server runs in UTC (Render), but all times are meant to be read in IST.** Two real bugs were fixed around this:
1. `formatSlotTime()` must explicitly pass `timeZone: "Asia/Kolkata"` to `toLocaleTimeString` — without it, a 9:00 AM IST slot displayed as "3:30 AM" on the production (UTC) server. This function is duplicated (small, intentionally) in `conversationEngine.ts`, `browseFlow.ts`, and `orderService.ts` — if you fix a formatting bug in one, check the others.
2. `getAvailablePickupSlots()` must reassemble the actual instant a slot occurs at (`slotEndInstant(slotDate, endTime)` — DATE + TIME combined) and filter against `now`, not just calendar day — a day-level filter alone still offered slots whose time had already passed today.

`istDayBounds(dateStr)` in `orderService.ts` converts a `"YYYY-MM-DD"` string (as picked from the dashboard's date input, representing an IST calendar day) to its UTC instant bounds — used by the Owner Dashboard's date-picker history view.

**Night-open stalls (`Stall.nightOpen`) get an extended slot window** (2026-08-09 fix): `slotGenerator.ts`'s `DEFAULT_CONFIG` only ever generated 9am-8pm slots — a night-open stall (e.g. Chaap Express) had **zero** pickup slots at all outside that window, so checkout correctly-but-unhelpfully showed "no slots available" any time after 8pm even though the stall itself was open. `generateSlotsForAllStalls` now passes a `NIGHT_OPEN_CONFIG` (6am-11:45pm) for stalls with `nightOpen: true`.
- **Why not a literal midnight-to-midnight day**: `PickupSlot.slotDate`/`startTime`/`endTime` are separate `@db.Date`/`@db.Time` columns with no timezone of their own. IST is UTC+5:30, so IST midnight through ~5:30am falls on the **previous** UTC calendar date — a slot generated for "today" whose intended IST time is, say, 2am silently gets attributed to yesterday's UTC-dated bucket, which `getAvailablePickupSlots`'s (correctly UTC-based) "today onward" filter then never finds: available, but invisible. Worse, a slot pair straddling that UTC-midnight boundary round-trips through the `@db.Time` column with its end reading back as numerically *before* its start (both get reconstructed against a shared synthetic epoch day using just their UTC time-of-day, discarding which actual date each belonged to) — a genuinely corrupt row, not just an invisible one.
- 6am-11:45pm IST maps entirely inside a single UTC calendar date, so it needs no cross-date handling and can't produce either failure mode. **Known remaining gap**: true dead-of-night (midnight-6am IST) still has no slots — fixing that properly needs slot generation to split at the UTC-midnight boundary (attributing pre-5:30am-IST slots to the previous UTC-dated bucket) or a schema change to a single timezone-aware instant column instead of separate Date+Time fields. Not done — out of scope for this fix, flagged here for whoever picks it up next.
- If you ever touch `slotGenerator.ts` again: `tests/integration/slotGenerator.test.ts` asserts night-open stalls get more/later slots than regular ones and that no slot has `endTime <= startTime` — a regression here would fail loudly.

## 4.8 Dashboard architecture

- Single Vite React app, two roles from one `Login.tsx` (role toggle: Stall Owner / Super Admin), routing to `/owner` or `/admin`.
- `App.tsx`'s `RequireRole` checks `localStorage`-persisted auth (`{token, role, name}`).
- Both dashboards share `components/Shell.tsx` (top nav, command palette, theme toggle, undo-toast).
- **Owner Dashboard**: live order queue (10s polling) grouped Needs Attention/Preparing/Ready, SLA & Accountability stat row, and a **date picker** (capped at today) — selecting a past date switches to a read-only snapshot (revenue/completed/completion-rate + the same SLA row scoped to that day + a flat list of every order placed that day) and stops polling; back to today resumes the live view.
- **Admin Dashboard**: Overview (live campus stats, attention panel, peak hour, activity feed), Stalls (search, bulk pause/resume, per-stall pause/night-open toggle, menu editor modal), Category Review, Assign Owners (now with Confirm Password + show/hide toggle — see §6), Students.
- `api/client.ts` attaches the Bearer token and silently retries GET requests once on a transient failure.

## 4.9 Stall Rating & Feedback (`services/ratingService.ts`, `ai/ratingFlow.ts`)

- After an owner marks an order `completed` (via `POST /api/owner/stalls/:id/orders/:orderId/status`, the only route a genuine owner-driven completion goes through — the no-show sweep calls `transitionOrderStatus` directly, so no-show closures never trigger this), `triggerRatingPrompt` fires a fire-and-forget WhatsApp list message: 5★ down to 1★.
- 4–5★ saves immediately with a thank-you. 1–3★ asks a reason (Food Quality / Service / Pickup Delay / Wrong Order / Other, List Message — 5 options exceeds the 3-button cap) then an optional free-text comment (`"skip"` or empty = no comment).
- Deterministic wizard: `session.ratingFlow`, checked with **top priority** in `handleIncomingMessage` (before `smartFlow`/`browseFlow`) since it's usually the very next message after a completion push. Step logic (`handleRatingFlowStep`) is inline in `conversationEngine.ts`, mirroring `smartFlow`; only the proactive trigger lives in the separate `ai/ratingFlow.ts` (imports `getSessionState` one-directionally from `conversationEngine.ts`, same pattern as `slaMonitor.ts`, to avoid a circular import).
- One rating per order: `Rating.orderId` is `@unique` (DB-enforced) plus an app-level pre-check in `ratingService.submitRating` for a friendlier error.
- **Anonymous by design, including to the stall owner** — no student identity is ever surfaced anywhere, not just hidden from other students. Students only ever see a stall's aggregate (`⭐ 4.6 (324 Ratings)`) in `list_stalls` and Browse Stalls — never reviews/comments/reviewer names (explicit system-prompt rule + no tool ever returns that data to the student-facing AI).
- Owners see aggregate + a reason breakdown + up to 20 recent comments (`GET /api/owner/stalls/:id/ratings`, Owner Dashboard's "Ratings & Feedback" section). Admins see campus-wide rankings (`GET /api/admin/stalls/rankings`, Overview tab).
- All aggregation is on-the-fly via `prisma.rating.aggregate`/`groupBy` — no denormalized `Stall.avgRating` field, matching this app's existing convention (see `analyticsService.ts`).

## 4.10 Offers & Promotions Engine (`services/offerService.ts`)

- `Offer` model supports 8 types (percentage/flat discount, buy-X-get-Y, free item, combo, happy hour, festival, min-order-value), each with optional `validFrom`/`validUntil`, `minOrderValue`, `maxDiscount`, and item/category scoping (`applicableItemIds`/`applicableCategoryNames` — plain string arrays, not FK-backed join tables, matching this app's "on-the-fly over denormalized tables" convention; empty arrays mean "whole menu").
- `offerService.computeBestOffer(stallId, cartLines)` evaluates every currently-active offer (`active: true` **and** within `validFrom`/`validUntil` — an expired or deactivated offer is never even considered) and returns the single highest-discount one. `orderService.placeOrder` calls this automatically inside its transaction, subtracts the discount from `totalAmount`, and writes an `OfferRedemption` row — the source of truth for usage count / total discount given (aggregated on the fly, same convention as ratings).
- The WhatsApp order confirmation explains which offer applied and the savings (`🎉 <name> applied (<explanation>) — you saved ₹X!`). A dedicated AI tool, `get_stall_offers`, lets the model answer "what's the best deal here" / "cheapest option" on request; `list_stalls` and Browse Stalls both surface active-offer counts below the rating line.
- Owner CRUD (`GET/POST/PATCH/DELETE /api/owner/stalls/:id/offers`, `.../offers/:id/activate|deactivate`) via a new "Offers" tab in the Owner Dashboard (list + create/edit slide-over + usage/discount stats). Admin gets a read-only campus-wide "Offers" tab (`GET /api/admin/offers`, `.../offers/analytics`) with enable/disable.

## 4.11 AI Business Assistant (`services/businessAssistantService.ts`)

- Reuses the existing Gemini client (`ai/geminiClient.ts`) — no new AI pipeline. `askOwnerAssistant(stallId, question)` gathers a JSON snapshot from **only that stall's own data** (today's completed orders/revenue/item sales/busiest hours via `orderService`, SLA metrics, `ratingService.getStallRatingDetail`, `offerService.getOfferAnalytics`) and prompts Gemini to answer solely from that snapshot with a concise, actionable recommendation — never inventing numbers.
- `askAdminAssistant(question)` gathers campus-wide aggregate data only (`analyticsService.getOverview`/`getStallInsights`, `ratingService.getStallRankings`, `offerService.getCampusOfferAnalytics`) — no individual student data is ever included in the prompt.
- New routes: `POST /api/owner/stalls/:id/ai-assistant` (ownership-checked like every other owner route) and `POST /api/admin/ai-assistant`. Both dashboards get an "Ask AI" tab with suggested-question chips and a simple chat-style transcript (`AskAiPanel`, duplicated per-dashboard per this app's small-component-duplication convention rather than a new shared-component module).
- Students never see this — it's owner/admin-only, gated by the existing `requireAuth("stall_owner"/"super_admin")` middleware already on every route in these routers.

## 4.12 Advanced Analytics Platform (`services/advancedAnalyticsService.ts`, `services/exportService.ts`)

- New "Analytics" tab on both dashboards with a Today/Week/Month/Custom date-range picker (`resolveDateRange` — week/month are **rolling** 7/30-day windows, not calendar week/month, for the same "avoid date-boundary edge cases" reasoning as the rest of this app; custom reuses `orderService.istDayBounds` for each endpoint, same convention as the existing Owner Dashboard history picker).
- **Deliberately reuses rather than recomputes**: `orderService.getSlaMetricsForStall` (acceptance/prep/SLA/no-show), `ratingService.getStallRatingDetail`/`getStallRankings` (rating detail/rankings), `offerService.getOfferAnalytics`/`getCampusOfferAnalytics` (offer usage/discount), `analyticsService`'s existing hour-bucketing pattern. Only genuinely new aggregations live in `advancedAnalyticsService.ts`: revenue/order/AOV for an arbitrary range, best/worst-selling items, category performance, new-vs-returning customers + repeat rate, peak hours, cancellation/no-show rate, revenue/rating trend lines (`ratingService.getRatingTrend`, day-bucketed), and campus-wide per-stall/per-block aggregation.
- `GET /api/owner/stalls/:id/analytics` / `GET /api/admin/analytics` (both accept `?period=today|week|month|custom&from=&to=`) return the full JSON payload the dashboard renders (KPI cards + `BarChart`/`TrendLine`, two new lightweight chart components added to `components/Shell.tsx` — plain SVG/CSS, no charting library dependency).
- **Export**: `GET .../analytics/export?format=csv|xlsx|pdf` — `exportService.ts` defines one common `AnalyticsReport` shape (`{title, summary, tables}`) that all three formats render from, so the export formats never diverge on what data they include, only how they present it. CSV/XLSX use the existing `xlsx` package (already a dependency); PDF uses `pdfkit` (added this session — pure-JS, no native/browser dependency, matching this app's "no queue/worker infra" philosophy).
- Admin Analytics adds a **stall-vs-stall comparison** picker (two dropdowns, side-by-side revenue/orders/rating) built from the same `stallComparison` array already returned for the campus view — no extra query.

## 4.13 AI Demand Forecasting System (`services/forecastService.ts`)

- New "AI Forecast" tab on both dashboards predicting **tomorrow's** demand from real historical data. Reuses `advancedAnalyticsService.getOwnerAnalytics`/`getAdminAnalytics` (a rolling 30-day "month" range) as the data snapshot — the only new query is a day-of-week order distribution, since neither existing service buckets by weekday.
- **Refuses to fabricate**: if a stall (or the campus) has fewer than `MIN_TOTAL_ORDERS` (10) orders across `MIN_ORDER_DAYS` (5) distinct days in the last 30, the endpoint returns `{ sufficient: false, reason: "..." }` *without ever calling Gemini* — this is a hard product requirement, not just a prompt instruction, so it can't be bypassed by a creative model response.
- Uses **structured Gemini output** (`config.responseMimeType: "application/json"` + `responseSchema`) rather than free text — the dashboard renders typed fields (`expectedOrdersTomorrow`, `peakHours`, `predictedBestSellers`, `suggestedPrepQuantities`, etc.) directly, no parsing/regex needed. The system prompt (`FORECAST_RULES`) explicitly forbids inventing numbers/names not present in the data snapshot and requires flagging thin fields (e.g. "no offers redeemed") instead of guessing.
- Owner forecast fields: expected orders/revenue/customer volume tomorrow, peak hours, offer/SLA-load expectations, predicted best/worst sellers, suggested prep quantities, recommended stock increases, staffing suggestion, sell-out/overstock risk lists, recommended offers for tomorrow, a `confidence` level, and a one-line `summary`.
- Admin forecast fields: expected campus orders/revenue tomorrow, busiest blocks, highest-demand stalls, expected peak hours, campus trends, `confidence`, `summary`.
- `GET /api/owner/stalls/:id/forecast` / `GET /api/admin/forecast` — no query params (always forecasts "tomorrow"); the dashboard has a manual "Regenerate" button rather than auto-refreshing, since each call is a real Gemini request.
- Verified via `tmpTest*.ts` scripts (deleted after use, per convention) against real production data — correctly reported insufficient data at current volumes — and against synthetic historical orders (12 orders across 6 distinct days, cleaned up after the run), which produced a full, schema-valid, data-grounded forecast on both endpoints.

## 4.14 Production security hardening

Closes most of §7's "High/Medium priority" security gaps (marked `~~done~~` there) — all additive, no existing route's request/response shape changed.

- **Webhook signature verification** (`routes/webhook.ts`): `X-Hub-Signature-256` is HMAC-SHA256-verified against the raw request body (captured via `express.json({ verify })` in `server.ts`, since a re-serialized body can differ byte-for-byte from what Meta actually signed). **Backward compatible on purpose**: if `WHATSAPP_APP_SECRET` isn't set, verification is skipped with a one-time warning rather than breaking the live webhook — it isn't set on Render yet (§7 item 4), so this is currently running in warn-only mode until that env var is added.
- **Rate limiting** (`lib/rateLimit.ts`, `express-rate-limit`): `apiLimiter` (600/15min) on `/api/owner` + `/api/admin`, `authLimiter` (15/15min) on every login endpoint, `otpLimiter` (8/5min) on OTP verification, `webhookLimiter` (120/min) on the webhook. **Critical gotcha caught during local verification, not after deploying**: `express-rate-limit` throws on every request if it sees an `X-Forwarded-For` header (which Render's proxy always adds) without Express's `trust proxy` set — `server.ts` now sets `app.set("trust proxy", 1)`. This was pushed as an immediate follow-up commit before it could take down production; if you ever see `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`-style errors after touching rate limiting, this is why.
- **Secure OTP**: `crypto.randomInt(100000, 1000000)` instead of `Math.random()`.
- **JWT hardening + logout** (`lib/auth.ts`): tokens now carry `iss`/`aud`/`jti` claims (rejects tokens minted for a different purpose/service); `POST /api/auth/logout` revokes the caller's own token via an in-memory `jti → expiry` map checked on every `requireAuth` call. **Known limitation** (documented in code, same pattern as `slaMonitor`'s in-process sweep): revocations live in memory only — lost on restart, not shared across instances. Fine for the current single-instance deployment; would need a shared store (DB/Redis) if this is ever scaled horizontally. The dashboard's existing logout button now calls this endpoint (best-effort — clears local auth and navigates away regardless of the network result).
- **Env validation** (`lib/env.ts`, called first thing in `server.ts`): fails fast in production if `DATABASE_URL` is missing, if `JWT_SECRET`/`WHATSAPP_*`/`GEMINI_API_KEY` are missing, or if `JWT_SECRET` is still the literal placeholder value — warns (doesn't block) on missing optional vars (`WHATSAPP_APP_SECRET`, `GOOGLE_CLIENT_ID`) so local dev without full WhatsApp credentials still works.
- **`/health`** now runs `SELECT 1` against the real database and returns `{status, db, uptimeSeconds, latencyMs}` (or 503 `{status:"degraded", db:"unreachable"}`) instead of a static `{status:"ok"}`.
- **Structured logging + audit trail** (`lib/logger.ts`): single-line JSON logs (`logger.info/warn/error`) used for the new security-relevant code paths (env validation, rate-limit rejections, rejected/invalid tokens, invalid webhook signatures, the global error handler) plus a new `auditLog()` helper wired into: login success/failure (owner + admin, password and Google), OTP issuance/expiry/incorrect-code, logout, offer create/update/delete/activate/deactivate (owner and admin), stall pause/resume/PATCH, bulk stall status changes, owner-account creation, and menu-item edits. **Deliberately not a full logging rewrite** — the many existing plain `console.log`/`console.error` calls throughout the app are untouched; this new logger is additive, specifically for events worth being able to grep/filter as `audit: true`.
- **Request correlation**: a per-request `X-Request-Id` (generated if the client doesn't send one) is echoed back and included in every error log line from the global handler, so a user-reported error can be matched to exact server-side log entries.
- **Startup WhatsApp token visibility**: a best-effort, non-blocking call to Meta's `debug_token` endpoint at boot logs whether the current access token is permanent (System User) or short-lived (USER) — pure observability, doesn't change how the token is used (see §3, still not fixed operationally).
- Verified end-to-end against a real running instance (not mocked, temporary `tsx src/server.ts` process on a scratch port): signed/unsigned/incorrectly-signed webhook payloads, `/health`'s DB check, a full login → protected-route → wrong-role-403 → logout → revoked-token-401 flow using a disposable owner fixture (created and deleted via Prisma), and the auth rate limiter actually returning 429 under repeated bad logins — plus the trust-proxy fix specifically verified against a request carrying a spoofed `X-Forwarded-For` header before it ever reached production.

## 4.15 Automated testing framework (Vitest)

- **Framework**: Vitest + Supertest — TS-native (no ts-jest transform step), fast, Jest-compatible `describe`/`it`/`expect` API. Config at `backend/vitest.config.mts`.
- **No separate test database exists** for this project — the suite runs against the same Supabase Postgres as production (see §2's Known Issues about the single free-tier DB). Every DB-touching test creates its own disposable, `TEST_FX_`-prefixed fixtures via `tests/helpers/fixtures.ts`'s `TestContext` and tears them down in `afterEach`/`finally` — the exact same create/assert/clean-up discipline this session's ad-hoc `tmpTest*.ts` scripts used throughout development (§9), just formalized into permanent, reusable suites instead of one-off deleted scripts.
- **`src/app.ts`**: the only structural change made to enable this — the Express app builder was extracted out of `server.ts` (which now just imports `createApp()`, calls `.listen()`, and starts the SLA sweep/token check) so `tests/api/*.test.ts` can drive the real app in-process via `supertest(app)` without binding a port or running the background cron. Production behavior via `server.ts` is unchanged.
- **Layout** (`backend/tests/`):
  - `unit/` — pure logic needing no DB: JWT sign/verify/revoke (`lib/auth.ts`), CSV/Excel/PDF export (`exportService.ts`), analytics date-range resolution (`advancedAnalyticsService.resolveDateRange`), and the WhatsApp client's request-building/truncation logic (`whatsapp/client.ts`, tested via a stubbed global `fetch`, not a real network call).
  - `integration/` — full workflows against the real DB: the student journey (browse → cart → checkout → owner lifecycle → pickup → rating), offer selection/discount/min-order-value correctness, SLA auto-reject/violation/no-show sweeps (calling `slaMonitor.runSlaSweep()` directly against crafted fixture timestamps), one-rating-per-order enforcement, analytics calculation correctness (revenue/new-vs-returning/best-worst-sellers against known fixture data), and forecast sufficient/insufficient-data paths (the sufficient-data case makes one real Gemini call, same as the manual testing done when that feature shipped).
  - `api/` — HTTP-level tests via `supertest(createApp())`: auth (login/OTP/logout), owner routes (stalls/offers/analytics/forecast/ratings), admin routes (overview/stalls/offers/analytics/forecast), webhook signature verification, `/health`. Covers 200/400/401/403/404/409/429 responses as they actually occur in this API (422/500 aren't used anywhere in this codebase's routes — 400 covers validation errors, 500 only reaches the client via the generic global error handler, which is deliberately not routinely triggered in tests since intentional error classes never reach it).
  - `security/` — rate limiting (a real 429 under repeated bad logins, isolated onto a synthetic IP via `X-Forwarded-For` so it doesn't rate-limit every *other* test's real logins for the rest of the run — see the bug note below), JWT tamper/expiry/wrong-issuer rejection, cross-owner and cross-role permission isolation.
  - `load/loadTest.ts` — **not** part of `npm test` (excluded in `vitest.config.mts`, run on demand via `npm run test:load`): fires 50 and then 100 concurrent `orderService.placeOrder()` calls at a capacity-limited pickup slot and asserts the DB never overbooks (`bookedCount` always equals however many actually succeeded, and never exceeds capacity) — this is the real race-condition check, distinguishing "capacity guard rejected it" from "connection pool couldn't keep up" in its output. Also does a lightweight HTTP latency/error-rate check against a running server if one's reachable (skipped otherwise).
- **Running it**: `npm test` (single run), `npm run test:watch`, `npm run test:coverage` (v8 coverage, HTML report in `backend/coverage/`, gitignored), `npm run test:load`.
- **Current scale**: 101 tests across 15 files, all passing. Coverage is intentionally uneven — the critical business services this task called out (`orderService` 79%, `ratingService` 75%, `forecastService` 93%, `exportService` 98%, `analyticsService` 92%, `lib/auth.ts` 84%, `whatsapp/client.ts` 80%) are well covered; the WhatsApp conversational AI layer (`ai/conversationEngine.ts`, `ai/browseFlow.ts`, `ai/ratingFlow.ts`) is not — exercising Gemini's tool-calling loop end-to-end would need extensive mocking of the AI itself, and that layer's existing verification method is `scripts/testChat.ts`'s manual CLI plus live WhatsApp testing (§9), which this task didn't replace. `advancedAnalyticsService.ts`'s admin-side aggregation (SLA-violation ranking, block popularity with real variance) is also thinner than the owner-side — a reasonable next target if this suite grows further, not a gap that blocks shipping.
- **Two real bugs found and fixed by this pass** (not pre-existing — both were introduced earlier this session by the Offers Engine and this test-fixture code, and are now fixed; not left as known issues):
  1. **`orderService.placeOrder` connection-pool bug**: `computeBestOffer()` was called from inside `prisma.$transaction(async (tx) => ...)` but used the module-level `prisma` client instead of `tx`, so every order placement silently opened a second DB connection while already holding one for its own transaction. Under concurrent load (the load test's whole point) this exhausted the connection pool roughly twice as fast as the raw concurrency alone would explain. Fixed by threading an optional Prisma client parameter through `getActiveOffersForStall`/`computeBestOffer` (`src/services/offerService.ts`) so a caller already inside a transaction reuses its connection; `orderService.ts` now passes `tx`. Verified via the load test before and after: the capacity-limiting guard itself was correct in both cases (never once overbooked), but the fix meaningfully reduced how many concurrent orders failed on `"Unable to start a transaction in the given time"` (a Prisma connection-pool timeout, not application logic).
  2. **Test fixture id collisions under concurrency**: `tests/helpers/fixtures.ts`'s `uniquePhone`/`uniqueWhatsapp`/etc. originally combined `Date.now()` with a small `Math.random()` range — fine sequentially, but colliding (unique-constraint violations on phone/whatsapp/`displayId`) the moment the load test created 50-100 fixtures inside one `Promise.all`. Replaced with a monotonic in-process counter.
- **Known limitation of the suite itself, honestly stated**: because there's no separate test DB, running `npm test` repeatedly against a live production database (even with careful fixture cleanup) isn't something to wire into an automatic CI trigger without first provisioning a dedicated test database/branch — that's an infrastructure decision for whoever sets up CI, not something fixed by this pass. The Supabase free-tier pooler's own connection limit (5, per the errors surfaced during load testing) is also a real ceiling on how many truly simultaneous DB transactions this deployment can sustain — worth knowing if a specific "how many concurrent orders can we handle" number ever matters operationally.

---

# 5. Database

Source of truth: `backend/prisma/schema.prisma` — always read it directly, this section is a summary.

## Models

| Model | Purpose | Notable fields |
|---|---|---|
| `Student` | WhatsApp end-user | `whatsappNumber` (unique), `name`, `registrationNumber` (stored, never validated), `lastSeen`, `sessionState` (Json), `isActive` |
| `StudentPreference` | Learned ordering habits (1:1 with Student) | `favoriteStallId`, `favoriteMealPeriod`, `preferredArea`/`preferredBlock`, `usualOrderItems` (Json), `favoriteItems` (Json), `ordersAnalyzed` — recomputed after every **non-no-show** completed order |
| `Stall` | Physical outlet | `@@unique([block, name])` — a brand can have multiple outlets; `status`, `nightOpen`, `pickupGraceMinutes` |
| `StallOwner` | Owner login | `phone` (unique), `email`/`googleId` (unique, optional — Google Sign-In) |
| `SuperAdmin` | Admin login | `email` (unique), `googleId` (unique, optional), `otpCode`/`otpExpiresAt` (2FA) |
| `CanonicalCategory` / `MenuCategory` | Category taxonomy | raw imported labels mapped (or pending review) to a shared taxonomy |
| `MenuItem` / `ItemVariant` | Menu | `basePrice` (Decimal), `available`, `imageUrl` |
| `PickupSlot` | Bookable time window | `slotDate` (Date) + `startTime`/`endTime` (Time) stored **separately** — see §4.7; `@@unique([stallId, slotDate, startTime])` |
| `Order` | Placed order | `displayId` (unique, customer-facing), full SLA field set (§4.5), `discountAmount` (offer applied, §4.10), `@@index([stallId, status])` |
| `OrderItem` | Order line item | `itemNameSnapshot` — frozen at order time so history displays correctly even if the menu item changes later |
| `Rating` | One rating per completed order (§4.9) | `orderId` `@unique`, `stars`, optional `reason`/`comment` — never exposes reviewer identity |
| `Offer` | Stall promotion (§4.10) | `type`, `active`, `validFrom`/`validUntil`, optional discount/min/max/scoping fields per type |
| `OfferRedemption` | One row per order an offer applied to (§4.10) | `orderId` `@unique`, `discountAmount` — source of truth for usage/discount analytics |

## Enums
- `OrderStatus`: `placed | accepted | rejected | preparing | ready | completed | cancelled`
- `StallStatus`: `active | paused`
- `MealPeriod`: `breakfast | lunch | snacks | dinner`
- `RatingReason`: `food_quality | service | pickup_delay | wrong_order | other`
- `OfferType`: `percentage_discount | flat_discount | buy_x_get_y | free_item | combo | happy_hour | festival | min_order_value`

## Migrations (chronological, all hand-written SQL)
`20260728191509_init` → `stall_owner_google` → `super_admin_2fa_google` → `stall_night_open` → `student_onboarding` → `student_preferences` → `order_display_id` → `order_sla_accountability` → `20260808_stall_ratings` → `20260808_offers_engine`. Apply new ones via `npx prisma migrate deploy` only — never `migrate dev`/`diff` against the production `DATABASE_URL`.

---

# 6. Real bugs found and fixed this session (don't reintroduce)

| Bug | Root cause | Fix |
|---|---|---|
| Search relevance / repeated "different" lists | `search_menu` had no `offset` support | Added `offset` param + explicit no-repeat prompt rule |
| Raw DB ids leaking into student-facing replies | Model occasionally echoed internal id lookups | `stripLeakedIds()` UUID-pattern safety net + explicit prompt rule |
| Infinite pickup-slot re-fetch loop | No `knownSlots` map, any ambiguous reply re-triggered `get_pickup_slots` | Added `knownSlots` (time-range → id), same pattern as `knownStalls`/`knownItems` |
| `MAX_TOOL_ITERATIONS` exhausted silently, masked as generic error | Old Groq-era cap of 3 was too low for Gemini's headroom | Raised to 8, added a distinct log line + friendlier fallback message |
| AI hallucinated a stall's location | No constraint on what the model could claim | Prompt rule: location claims must come verbatim from `area`/`block` fields, nothing invented |
| Cart-conflict dead end | Add-to-cart from a second stall showed a warning with no way forward — "clear"/"checkout" replies matched nothing and looped forever | Added **Clear & Add** / **Cancel** buttons |
| Post-add-to-cart confusion ("only the latest item is showing, no checkout") | Cart accumulation was actually correct — but there was no visible way to view the full cart or check out after adding | Added explicit **Add More / View Cart / Checkout** buttons after every add |
| Checkout button occasionally triggered a random menu search | "Checkout" button title routed through the AI as free text; the model sometimes misread the emoji-prefixed title | Checkout is now deterministic — calls `menuService` directly, no AI involved |
| Pickup times displayed in the wrong hour | `formatSlotTime` didn't pin `Asia/Kolkata`; UTC production server showed raw UTC time | Explicit `timeZone: "Asia/Kolkata"` everywhere this is formatted |
| Pickup-slot picker offered already-passed times | Filter was day-level only, not instant-level | `slotEndInstant()` combines DATE+TIME and filters against `now` |
| Order confirmation/status text hand-written by the AI from raw UTC timestamps | Same timezone issue, plus inconsistent formatting | `place_order`/`get_order_status` now return a pre-formatted `summary` string; the AI is instructed to relay it verbatim |
| Redundant "Pick a pickup time below." text alongside the slot list | Both the list header and a separate AI-authored text said the same thing | Dropped the separate text entirely — the list's own header covers it (with a dynamic "nothing near X" variant when relevant) |
| Order-placed confirmation arrived *after* the Track/Cancel buttons | Side-effect sends (buttons) always ran before the returned text reply was dispatched by the caller | Text is now sent first, from inside the same function, whenever a follow-up is coming |
| Stale/days-old orders resurfacing in "Track Order" | `getActiveOrdersForStudent` had no time-based expiry | Orders expire from "active" status 15 minutes after their pickup window ends |
| Auto-reject "you could also try" was a dead text list | Plain numbered text, nothing tappable | Real tappable stall list, primes `browseFlow` so tapping one continues shopping there |
| Rejection notice arrived *after* the alternative-stalls list | `notifyStudentOfStatus` was fire-and-forget (unawaited) | Made it a properly awaited async function (errors still swallowed internally so a notification failure never fails the transition) |
| Onboarding silently skipped / a real student's name corrupted to `"Hi"` | Concurrent `handleIncomingMessage` calls for the same number raced on the same `Student` row | Per-phone-number serialization queue in `webhook.ts` (§4.4) |
| Owner Dashboard Assign Owners form: email field showed an unrelated pre-filled value | Chrome autofill guessing on a field with no `autoComplete` hint (not a code bug — state defaults to `""`) | Added `autoComplete="off"`/`"new-password"` across the form |
| No way to verify a typed password before creating an owner login | Single password field, no confirm, no show/hide | Added Confirm Password field + eye-icon show/hide toggle (reusing the existing Login-page pattern) |
| Owner Dashboard had no history — only "today" | No date-scoped query existed | Added `orderService.getOrdersForDay`/`istDayBounds`, a `?date=` param on the SLA-metrics route, and a dashboard date picker (§4.8) |

**Not a bug (worth remembering so it isn't re-investigated):** the Login page showing a real, previously-used phone number/password pre-filled is Chrome's own saved-password autofill, not app state — `Login.tsx`'s fields initialize to `""`. Browsers deliberately keep this working even with `autoComplete="off"` on genuine login forms; it can only be cleared from the browser's own password manager, not from the app.

---

# 7. Known open issues / remaining work

## High priority
1. **WhatsApp access token is not permanent** (§3) — the single biggest recurring operational chore. Needs a System User token. (Startup now logs the token's type/expiry via Meta's `debug_token` endpoint — see §4.14 — but generating the permanent token itself is still a manual one-time Meta Business Settings step nobody has done yet.)
2. **No cron for pickup-slot generation** — `npm run generate:slots` must be run manually or scheduled externally.
3. **No `completed`-status WhatsApp notification** — `STATUS_LINES` has no entry for it.
4. ~~No WhatsApp webhook signature verification~~ — **Done** (§4.14): `X-Hub-Signature-256` is verified when `WHATSAPP_APP_SECRET` is set. **Still open:** that env var isn't set on Render yet, so verification is currently running in its backward-compatible "skip + warn" mode — add `WHATSAPP_APP_SECRET` (Meta App Dashboard → Settings → Basic) to actually enforce it.

## Medium priority
5. **No WhatsApp message templates** — all messaging is free-form, only valid within the 24-hour customer-service window. An order-ready notification sent after that window silently fails to reach the student.
6. ~~No rate-limiting~~ — **Done** (§4.14): general/auth/OTP/webhook limiters via `express-rate-limit`.
7. ~~`JWT_SECRET` insecure default~~ — **Done** (§4.14): startup now refuses to run in production with the placeholder value.
8. ~~OTP generation uses `Math.random()`~~ — **Done** (§4.14): switched to `crypto.randomInt`.
9. ~~No token revocation/logout~~ — **Done** (§4.14): `POST /api/auth/logout` + in-memory jti revocation set.
10. ~~No automated tests anywhere~~ — **Done** (§4.15): a real Vitest suite (101 tests) now exists. `backend/src/scripts/testChat.ts`'s manual CLI and ad-hoc `tmpTest*.ts`-then-delete scripts remain the pattern for one-off verification during a specific change (still used constantly, see §9) — the new suite is for regression coverage of the critical flows, not a replacement for that habit.
11. ~~No structured logging / error tracking~~ — **Partially done** (§4.14): new `lib/logger.ts` (structured JSON) + `auditLog()` cover auth/webhook/rate-limit events and the sensitive mutations listed there. Still no external error-tracking service (Sentry-equivalent), and most non-security `console.log`/`console.error` calls elsewhere in the app are untouched by design (see §4.14's rationale).
12. ~~`/health` doesn't check DB connectivity~~ — **Done** (§4.14): now runs `SELECT 1` and reports `db`/`uptimeSeconds`/`latencyMs`.
13. **Dashboard pagination** — Students tab, activity feed, menu items all render unbounded lists.
14. **Admin Dashboard has no per-order table** — only aggregate stats; no order-level view/search for the Super Admin.

## Lower priority
15. Payment integration (or explicitly document "cash on pickup only" as final, not just deferred).
16. Multi-stall-owner support is half-wired (schema/API support `stallIds: []`, the Assign Owners form only ever creates one stall per owner).
17. `groqClient.ts` still exists in `src/ai/` — dead code from before the Gemini migration, safe to delete.
18. Real icon library was adopted (`lucide-react`) for the dashboard — this item from the old handoff is done.

---

# 8. Code style (unchanged conventions, still apply)

- TypeScript strict mode, both projects — don't loosen it.
- Comments explain **why**, not what — no restating obvious code in prose.
- No premature abstraction — plain functions in `services/`, plain Express handlers, no repository pattern/DI container.
- Zod validation on every route accepting a body.
- Every async route handler wrapped in `asyncHandler` — non-negotiable after the earlier crash-on-unhandled-rejection incident.
- Prisma queries live in `services/`, not `routes/` (auth routes are a minor, accepted exception).
- Small helper functions (`formatSlotTime`, `ORDER_STATUS_EMOJI`, `slotEndInstant`-equivalents) are **intentionally duplicated** across `conversationEngine.ts`/`browseFlow.ts`/`orderService.ts` rather than sharing a util module — an established, deliberate pattern in this codebase for small pieces of logic used in a couple of places; don't "fix" this into a shared module without a reason, but also don't propagate a bug into only one copy — check the others when fixing formatting/timezone issues.
- Frontend: functional components + hooks only, plain CSS via `index.css` design tokens (no Tailwind/CSS-in-JS), Framer Motion used sparingly (short durations, `easeOut`, small translate distances).

---

# 9. Important standing instructions from the project owner

- **Never point `--shadow-database-url` at production, ever.** Hand-write migration SQL, apply via `migrate deploy` only. (See §2 — this caused two full production data-loss incidents earlier in the project.)
- This project's established working pattern throughout has been: commit + push + deploy after every shipped fix, with a clear commit message, without needing a fresh ask each time — the user reviews results live on WhatsApp/the dashboard rather than approving each deploy individually.
- Verify changes end-to-end (via scripted `tmpTest*.ts` runs against real data, deleted after use) before considering a fix shipped — this project has a history of subtle concurrency/timezone/ordering bugs that only surface under realistic conditions, not just `tsc --noEmit` passing.
- The user tests live on WhatsApp and the dashboard and reports back with screenshots, often in Hinglish — match that register when responding, and treat a screenshot as ground truth over assumptions about what the code "should" do.
