# InfraStudio — Landing Page

A high-end, static marketing site for **InfraStudio**, an AI-native engineering
design platform that turns natural-language design intent into computable,
editable, and validated BIM/IFC models.

## Stack

Plain HTML/CSS/JS — no build step required. 3D visuals use [Three.js](https://threejs.org/)
loaded from a CDN as a progressive enhancement (the page degrades gracefully
without it). Fonts are Inter + JetBrains Mono via Google Fonts.

## Running locally

Recommended — the bundled dev server also handles waitlist submissions:

```bash
cd InfraStudio
node server.js         # or: npm start
# then open http://localhost:3000
```

Any static file server also works for browsing the site itself (e.g.
`python3 -m http.server`), but only `server.js` saves waitlist submissions.

## Structure

```
InfraStudio/
├── index.html          # full page markup (all sections)
├── css/style.css        # design system + layout + components
├── js/main.js            # nav, scroll reveals, waitlist modal, 3D hero scene
├── server.js             # local dev server + POST /api/waitlist -> CSV
├── data/
│   └── waitlist.csv       # created on first run/submission (gitignored)
├── assets/
│   ├── favicon.svg
│   └── og-image.svg
└── README.md
```

## Waitlist form

There are two distinct asks, each with its own copy and fields, sharing one
modal:

- **Request Early Access** — name, email, profession, optional notes.
- **Become a Design Partner** — the same fields plus a required studio/company
  name, since this is a deeper, more formal commitment.

Every submission is tagged with a `type` (`early-access` or `design-partner`)
so the two are easy to tell apart downstream.

**Storage, for now:** submissions are POSTed to `/api/waitlist`, which
`server.js` appends as a row to `data/waitlist.csv` (columns: `submittedAt,
type, name, email, profession, company, notes`). This is a deliberate stopgap
before a real backend/database exists — swap `server.js`'s `POST
/api/waitlist` handler for a call to whatever service replaces it (a
serverless function, Airtable, Supabase, etc.) and the front end
(`js/main.js`) needs no changes, since it already POSTs JSON to that same
endpoint. If the server isn't running (e.g. the site is opened from a plain
static host), the form falls back to saving the entry in the visitor's
`localStorage` instead, so it still works, just without central collection.

`data/waitlist.csv` is gitignored since it will contain real names and email
addresses once people start signing up — don't commit it.

## Notes

- **"Try Now"** links out to the live prototype at
  `https://infra-studio-z3xc.vercel.app`.
- No fabricated metrics, logos, testimonials, or traction claims are used,
  per the product's current working-prototype stage.
