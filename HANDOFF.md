# LPU WhatsApp Food Pre-Booking System — Engineering Handoff

**Purpose:** a complete handoff so a new engineer (or Claude session) can pick this project up with zero prior context. Read this whole document before touching code. The previous version of this file described an early, local-only, Groq-powered prototype — that phase is over. Everything below reflects the system as actually deployed today.

**Last updated:** 2026-08-08 (Stall Rating & Feedback, Offers & Promotions Engine, AI Business Assistant, and an Advanced Analytics Platform shipped this session — see §4.9–§4.12).

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
1. **WhatsApp access token is not permanent** (§3) — the single biggest recurring operational chore. Needs a System User token.
2. **No cron for pickup-slot generation** — `npm run generate:slots` must be run manually or scheduled externally.
3. **No `completed`-status WhatsApp notification** — `STATUS_LINES` has no entry for it.
4. **No WhatsApp webhook signature verification** — `POST /webhook/whatsapp` trusts any correctly-shaped payload; only the one-time `GET` handshake checks `verify_token`. Should verify `X-Hub-Signature-256` against the Meta app secret.

## Medium priority
5. **No WhatsApp message templates** — all messaging is free-form, only valid within the 24-hour customer-service window. An order-ready notification sent after that window silently fails to reach the student.
6. **No rate-limiting** anywhere (login, OTP verify, webhook).
7. **`JWT_SECRET` falls back to an insecure hardcoded default** if unset — currently only safe because the env var is actually set on Render.
8. **OTP generation uses `Math.random()`**, not a CSPRNG.
9. **No token revocation/logout** — JWTs are stateless, valid for the full 12h.
10. **No automated tests anywhere** — everything verified via live manual/scripted testing (see `backend/src/scripts/testChat.ts` for the manual chat-testing CLI; ad-hoc `tmpTest*.ts` scripts were used throughout this session and deleted after each verification — that's the established pattern for testing a change before shipping it).
11. **No structured logging / error tracking** — `console.log`/`console.error` only, no Sentry-equivalent.
12. **`/health` doesn't check DB connectivity.**
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
