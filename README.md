# Bounty Hunter - Most Wanted & Bounties To-Do PWA

A responsive, high-performance To-Do List Progressive Web App (PWA) built with **Next.js (App Router)**, **Tailwind CSS**, **@dnd-kit**, **Lucide Icons**, **Neon Serverless Postgres**, and **Neon Auth**.

---

## 🌟 Highlights & Features

1. **Daily Task Management & Drag-and-Drop Reordering**:
   - Touch & pointer drag handles powered by `@dnd-kit/core` and `@dnd-kit/sortable`.
   - Tuned touch sensors with activation constraints that allow fluid vertical scrolling while enabling immediate hold-and-drag reordering.
   - Inline title editing, interactive checkbox animations, and fast deletion.

2. **Automatic Midnight Rollover**:
   - Automatically migrates uncompleted tasks from past days into today's active priorities on launch or date rollover.
   - Completed past tasks are archived in the historical archive tab.
   - Displays a banner highlighting rolled-over tasks.

3. **Bonus Task Pool & Completion Rewards**:
   - Manage ideas and secondary tasks in the **Bounties** tab.
   - **Auto-Reward Trigger**: Completing 100% of today's active tasks fires a celebration (`canvas-confetti`), chimes audio rewards, and pulls **one random task** from the bonus pool into today's daily focus.
   - Guards against duplicate triggers within the same day.

4. **Neon Cloud Sync & Local-First Offline Mode**:
   - **Zero configuration required to start**: Works instantly offline via LocalStorage persistence.
   - **Neon Serverless Postgres & Neon Auth sync**: Configure `DATABASE_URL`, `NEON_AUTH_BASE_URL`, and `NEON_AUTH_COOKIE_SECRET` in `.env.local` to enable multi-device cloud synchronization via Neon Serverless Postgres (`@neondatabase/serverless`) and Neon Auth (`@neondatabase/auth`).

5. **Progressive Web App (PWA)**:
   - Web App Manifest (`/manifest.json`) and Service Worker (`/sw.js`) for offline caching.
   - Installable on iOS (Safari Add to Home Screen) and Android / Desktop Chrome.
   - Safe-area insets (`env(safe-area-inset-bottom)`), responsive bottom tab navigation, and dark/light mode toggles.

---

## 🚀 Getting Started

### 1. Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 2. Build for Production
```bash
npm run build
npm run start
```

---

## 🗄️ Neon Cloud Sync Setup

1. Link and deploy your Neon project services (`postgres`, `auth`) via `neon init` and `neon deploy`.
2. Ensure `.env.local` contains `DATABASE_URL`, `NEON_AUTH_BASE_URL`, and `NEON_AUTH_COOKIE_SECRET`.
3. Apply the schema in `neon/schema.sql`.
4. Sign in or register in the **Settings** tab to synchronize your ledger with Neon Serverless Postgres.
