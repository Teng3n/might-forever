# Might Forever Guild Site

Pre-launch Astro site and planning backend for the Might Forever World of Warcraft guild.

The `might-forever` branch is intentionally a clean foundation. The MoP-era roster, loot,
calendar, and progression data remain preserved on the `feature/guild-site-mvp` archive branch and
are not exposed by this deployment.

## Current site

- Public home page with pre-launch status and systems roadmap.
- Empty roster contract ready for a future roster workbook.
- Officer-gated launch survey analytics.
- No public loot, calendar, dashboard, raid guide, player, or progression routes.
- No scheduled data polling. All workflows are manual-only.

## Design system

Might Forever uses a midnight, indigo, and amethyst palette rather than the MoP archive's green and
gold. The main tokens live at the top of `src/styles/global.css`.

## Local development

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run check
npm run build
```

## Cloudflare Pages

Use these production settings:

- Project name: `might-forever`
- Production branch: `might-forever`
- Build command: `npm run build`
- Build output directory: `dist`

Officer access uses the existing Pages Function authentication. Configure one of the following in
the Cloudflare project environment:

- `SYNC_TRIGGER_PASSWORD_HASH` (preferred SHA-256 hex digest)
- `SYNC_TRIGGER_PASSWORD` (fallback plaintext secret)

## Launch survey analytics

Source workbook:

`https://docs.google.com/spreadsheets/d/1EuKIShP55UUqlD0H3Ho_n00W9vaYnHcGMcdzDH9AcGw/edit#gid=352637669`

The site stores only aggregate counts in `src/data/surveyInsights.json`. Discord usernames and the
free-text specialization column are never written to the repository or rendered by the dashboard.

Refresh aggregates locally:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON='<service account JSON>' npm run sync:survey
```

Optional variables:

- `SURVEY_SHEET_ID`, already defaulted to the response workbook ID.
- `SURVEY_RESPONSES_RANGE`, default `'Form Responses 1'!A:M`.

The workbook must be shared read-only with the service account in `GOOGLE_SERVICE_ACCOUNT_JSON`.
The manual GitHub workflow is `.github/workflows/sync-survey.yml`.

## Future data contracts

The existing scripts and route code are retained as scaffolding for future systems, but their
generated JSON is empty on this branch. When the new sources exist:

1. Configure the roster/calendar workbook and its ranges.
2. Define the loot policy before enabling loot routes.
3. Configure the new Warcraft Logs guild identity after launch.
4. Remove only the relevant redirects from `public/_redirects` as each feature becomes ready.
