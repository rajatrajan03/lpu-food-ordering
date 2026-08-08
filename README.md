# 🍔 LPU Food — WhatsApp-Native Campus Food Ordering

> Order food from any campus stall by just chatting on WhatsApp. No app to install, no website to visit — WhatsApp *is* the app.

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-4169E1?logo=postgresql&logoColor=white)](https://supabase.com)
[![WhatsApp Cloud API](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=white)](https://developers.facebook.com/docs/whatsapp)
[![Gemini](https://img.shields.io/badge/AI-Google%20Gemini-4285F4?logo=googlegemini&logoColor=white)](https://ai.google.dev)
[![Render](https://img.shields.io/badge/Deployed-Render-46E3B7?logo=render&logoColor=white)](https://render.com)

---

## What this is

A real, working food pre-booking system for a university campus, built around one idea: **students should never have to leave WhatsApp.**

| Role | Where they live | What they do |
|---|---|---|
| 🎓 **Student** | WhatsApp only | Chat naturally *or* tap through button/list menus — browse stalls, search the menu, build a cart, get personalized "usual order" suggestions, pick a pickup slot, place/track/cancel orders |
| 🧑‍🍳 **Stall Owner** | Web dashboard | Manage a live order queue — accept, prepare, mark ready, complete, pause/resume the stall — and see SLA/accountability stats and full order history by date |
| 🛡️ **Super Admin** | Web dashboard | Onboard stalls, assign owners, curate the menu category taxonomy, edit menu items, monitor the whole campus in one operations view |

The AI never invents menu items, prices, or availability — every answer is backed by a real database lookup via tool-calling.

---

## Live

| | URL |
|---|---|
| WhatsApp bot | message the configured test number (see Meta app "Food AI Chatbot") |
| Dashboard | https://lpu-food-dashboard.onrender.com |
| Backend API | https://lpu-food-ordering.onrender.com |
| Health check | https://lpu-food-ordering.onrender.com/health |

Both services are deployed on [Render](https://render.com) (backend as a Docker web service, dashboard as a static site), auto-deploying from `master`.

---

## Highlights

- **Button-first WhatsApp UX** — Home screen (Browse Stalls / For You / More) using Meta's Reply Buttons and List Messages, not just free text. Every screen has Back/Home; typed messages that don't match a button still fall through to the AI, so natural language always works too.
- **AI ordering assistant** — Gemini (`gemini-flash-lite-latest`) with function-calling drives free-text conversation: search, cart, pickup slots, order placement, cancellation, order history/repeat-last-order.
- **Personalized suggestions ("For You")** — learns a student's favorite stall, meal period, and "usual order" from completed orders, and can rebuild a matching cart at a stall that currently stocks everything.
- **First-time onboarding + returning-visit greetings** — collects registration number and preferred name once, greets differently depending on how long it's been since the last visit. Rejects obvious junk (a student replying "hi" to "what's your name?" doesn't get "Hi" saved as their name).
- **Order SLA & Accountability system** — every order gets a 10-minute owner accept/reject deadline (auto-rejected with no penalty to the owner if missed, with a tappable list of nearby alternative stalls sent to the student); SLA violations are flagged when an order isn't marked ready before its pickup slot ends; orders not collected within the pickup slot + a configurable grace period are closed out as a no-show, never counted against the owner.
- **Atomic, overbooking-safe pickup slots** — slot booking runs inside a database transaction with an atomic capacity check, so concurrent rush-hour orders can never oversell a slot.
- **Random customer-facing order IDs** (`ORD-XXXXXXXX`) — decoupled from internal sequence/timestamp on purpose.
- **Operations-center dashboard** — live campus stats, an attention queue (stuck orders, unassigned stalls, pending category reviews), category/peak-hour analytics, night-open stall toggles, bulk pause/resume, and a date-picker history view on the Owner Dashboard for any past day's orders/revenue/SLA stats.
- **Per-number message serialization** — overlapping WhatsApp messages from the same student are processed strictly one at a time, so rapid double-messages can't race and corrupt session/cart state.
- **Dark mode, done properly** — every color in the UI is a design token.
- **Crash-hardened backend** — every route wrapped in a safety net so a single failed request (or a transient DB blip) can never take the whole server down.

---

## Tech stack

```
backend/     Node.js 20 · TypeScript · Express · Prisma · PostgreSQL (Supabase)
dashboard/   React 19 · Vite · TypeScript · Framer Motion · lucide-react · hand-rolled CSS design system
AI           Google Gemini (gemini-flash-lite-latest, tool-calling)
Messaging    Meta WhatsApp Cloud API (text, Reply Buttons, List Messages)
Deployment   Render (Docker web service + static site)
```

No Tailwind, no component library beyond `lucide-react` for icons — the dashboard's design system is plain CSS custom properties.

---

## Project structure

```
LPU Food Chatbot/
├── backend/
│   ├── prisma/schema.prisma       ← source of truth for the data model
│   └── src/
│       ├── ai/
│       │   ├── conversationEngine.ts  ← main per-message loop, Gemini tool-calling, onboarding/greeting gate
│       │   ├── browseFlow.ts          ← deterministic button-first Home/Browse Stalls/More wizard
│       │   ├── tools.ts               ← tool schemas, SessionState/BrowseFlowState types
│       │   └── geminiClient.ts        ← Gemini client singleton
│       ├── routes/                ← webhook, auth, owner API, admin API
│       ├── services/
│       │   ├── orderService.ts        ← order lifecycle, atomic slot booking, SLA fields, display ids
│       │   ├── slaMonitor.ts          ← in-process sweep: auto-reject / SLA violation / no-show detection
│       │   ├── menuService.ts         ← search, stall listing, pickup slot queries, night-hours filtering
│       │   ├── studentService.ts      ← onboarding, return-visit greetings
│       │   ├── preferenceService.ts   ← "usual order" learning from completed orders
│       │   ├── analyticsService.ts    ← Admin Overview aggregations
│       │   └── slotGenerator.ts       ← generates PickupSlot rows
│       └── whatsapp/               ← Meta Cloud API client (text/buttons/list)
├── dashboard/
│   └── src/
│       ├── components/            ← shared Shell, command palette, stat cards
│       └── pages/                 ← Login, Owner Dashboard, Admin Dashboard
└── data/                          ← source spreadsheet for the initial menu import
```

---

## Getting started

### 1. Free accounts you'll need

| Service | Why | Get it |
|---|---|---|
| Postgres | Application database | [Supabase](https://supabase.com) or [Neon](https://neon.tech) free tier |
| Google AI Studio | The LLM powering student chat | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Meta for Developers | WhatsApp Cloud API + free test number | [developers.facebook.com/apps](https://developers.facebook.com/apps) |
| Google Cloud Console (optional) | Google Sign-In for owner/admin login | [console.cloud.google.com](https://console.cloud.google.com) — create an OAuth Client ID |

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
cp dashboard/.env.example dashboard/.env
```

Fill in `DATABASE_URL`, `GEMINI_API_KEY`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and a `WHATSAPP_VERIFY_TOKEN` of your choosing in `backend/.env`. `GOOGLE_CLIENT_ID` is optional — omit it to disable Google Sign-In (phone+password / email+password still work).

> ⚠️ Use your database provider's **pooler** connection string, not the direct one.

### 3. Backend

```bash
cd backend
npm install
npm run prisma:migrate                 # creates all tables
npm run import:data                    # loads data/lpu-canteen-data.xlsx
npm run generate:slots -- 7            # generates pickup slots for the next 7 days
npm run create:admin -- --name "Your Name" --email you@example.com --password "changeme123"
npm run dev                            # http://localhost:3000
```

### 4. Dashboard

```bash
cd dashboard
npm install
npm run dev                            # http://localhost:5173
```

Log in as Super Admin with the account you just created, then:
- **Stalls** → view every imported stall as cards, pause/resume, toggle night-open, edit details, manage each stall's menu
- **Category review** → assign any raw category labels the importer couldn't auto-match
- **Assign owners** → create a phone + password (or Google) login for each stall owner

### 5. Let WhatsApp reach your webhook

WhatsApp needs a public HTTPS URL. For local development, tunnel port 3000 (e.g. `ngrok http 3000`) and set the resulting URL + your verify token as the webhook callback in the Meta app dashboard, subscribed to the `messages` field.

### 6. Keep pickup slots and the SLA sweep running

- `npm run generate:slots -- <days>` has **no cron wired up** — it must be run manually (or scheduled) or stalls run out of bookable slots.
- The Order SLA sweep (`services/slaMonitor.ts`) starts automatically with the server (`setInterval`, every 60s) — no separate setup needed.

---

## What's deliberately not built (v1 scope)

- 💳 Online prepayment — pay-at-pickup by design, matching how campus canteens already operate
- 🪪 Student identity verification — registration number is stored but never validated, by design
- 📨 WhatsApp message templates for notifications outside the 24-hour customer-service window
- 🧪 Automated tests — everything has been verified via live manual/scripted testing so far

See `HANDOFF.md` for the full engineering handoff, known issues, and prioritized remaining work.

---

<p align="center">Built for a real campus, by a solo developer, on a near-zero infrastructure budget.</p>
