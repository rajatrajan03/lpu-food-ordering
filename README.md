# 🍔 LPU Food — WhatsApp-Native Campus Food Ordering

> Order food from any campus stall by just chatting on WhatsApp. No app to install, no website to visit — WhatsApp *is* the app.

[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Supabase-4169E1?logo=postgresql&logoColor=white)](https://supabase.com)
[![WhatsApp Cloud API](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=white)](https://developers.facebook.com/docs/whatsapp)
[![Groq](https://img.shields.io/badge/AI-Groq%20LLM-F55036)](https://groq.com)

---

## What this is

A real, working food pre-booking system for a university campus, built around one idea: **students should never have to leave WhatsApp.**

| Role | Where they live | What they do |
|---|---|---|
| 🎓 **Student** | WhatsApp only | Chat naturally with an AI assistant — browse stalls, search the menu, build a cart, pick a pickup slot, place/track/cancel orders |
| 🧑‍🍳 **Stall Owner** | Web dashboard | Manage a live order queue — accept, prepare, mark ready, complete, pause/resume the stall |
| 🛡️ **Super Admin** | Web dashboard | Onboard stalls, assign owners, curate the menu category taxonomy, monitor the whole campus in one operations view |

The AI never invents menu items, prices, or availability — every answer is backed by a real database lookup via tool-calling.

---

## Highlights

- **WhatsApp-native ordering** — a Groq-hosted LLM with function-calling drives the entire student conversation: search, cart, pickup slots, order placement, cancellation.
- **Atomic, overbooking-safe pickup slots** — slot booking runs inside a database transaction with an atomic capacity check, so concurrent rush-hour orders can never oversell a slot.
- **Operations-center dashboard** — not a CRUD panel. Live campus stats, an attention queue (stuck orders, unassigned stalls, pending reviews), category/peak-hour analytics, and a Ctrl+K command palette.
- **Real-time-feeling owner queue** — orders grouped by urgency (Needs Attention → Preparing → Ready), optimistic UI on every action, and an undo window on destructive actions like rejecting an order.
- **Dark mode, done properly** — every color in the UI is a design token, so theming is a single CSS variable swap, not a rewrite.
- **Crash-hardened backend** — every route wrapped in a safety net so a single failed request (or a transient DB blip) can never take the whole server down.

---

## Tech stack

```
backend/     Node.js 20 · TypeScript · Express · Prisma · PostgreSQL (Supabase)
dashboard/   React 19 · Vite · TypeScript · Framer Motion · hand-rolled CSS design system
AI           Groq (tool-calling LLM)
Messaging    Meta WhatsApp Cloud API
```

No Tailwind, no component library — the dashboard's entire design system is plain CSS custom properties, deliberately kept dependency-light.

---

## Project structure

```
LPU Food Chatbot/
├── backend/
│   ├── prisma/schema.prisma       ← source of truth for the data model
│   └── src/
│       ├── ai/                    ← conversation engine, tool schemas, Groq client
│       ├── routes/                ← webhook, auth, owner API, admin API
│       ├── services/               ← order lifecycle, menu search, slot generation, analytics
│       └── whatsapp/               ← Meta Cloud API client
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
| Groq | The LLM powering student chat | [console.groq.com/keys](https://console.groq.com/keys) |
| Meta for Developers | WhatsApp Cloud API + free test number | [developers.facebook.com/apps](https://developers.facebook.com/apps) |

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
cp dashboard/.env.example dashboard/.env
```

Fill in `DATABASE_URL`, `GROQ_API_KEY`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and a `WHATSAPP_VERIFY_TOKEN` of your choosing in `backend/.env`.

> ⚠️ Use your database provider's **pooler** connection string, not the direct one — see the note in `backend/.env.example`.

### 3. Backend

```bash
cd backend
npm install
npm run prisma:migrate                 # creates all tables
npm run import:data                    # loads data/lpu-canteen-data.xlsx
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
- **Stalls** → view every imported stall as cards, pause/resume, edit details, manage each stall's menu
- **Category review** → assign any raw category labels the importer couldn't auto-match
- **Assign owners** → create a phone + password login for each stall owner

### 5. Let WhatsApp reach your webhook

WhatsApp needs a public HTTPS URL. For local development, tunnel port 3000 (e.g. `ngrok http 3000`) and set the resulting URL + your verify token as the webhook callback in the Meta app dashboard, subscribed to the `messages` field.

---

## What's deliberately not built (v1 scope)

- 💳 Online prepayment — pay-at-pickup by design, matching how campus canteens already operate
- 🪪 Student identity verification — phone-number-only for now; the schema doesn't block adding it later
- 📨 WhatsApp message templates for notifications outside the 24-hour customer-service window

---

<p align="center">Built for a real campus, by a solo developer, on a near-zero infrastructure budget.</p>
