# Rainy Season Commute Safety Portal

Portal for SRM Easwari Engineering College, Bharathi Salai, Ramapuram, Chennai 600089.
Students report rainy season travel problems. The college coordinator reviews them against
official rain alerts and confirms a daily level. Leave and attendance notices are approved by
the principal. Dashboards show students and reports by home area.

No packages to install. It needs Node.js 22.13 or newer.

## First run

1. Create the first administrator:
   `npm run create-admin -- "Full Name" admin@college.edu "a-long-password"`
2. Start the portal: `npm start` (opens on port 3000; set `PORT` to change it).
3. Sign in as the administrator, open **Accounts and settings**, and:
   - create the accounts the principal nominates (portal coordinator, transport in-charge, principal);
   - import the student roster (register number, college email, name, one per line);
   - correct the area list and, if the college wants, the severity and area-class thresholds.
4. Students can then register at `/register.html`. Registration stays closed until a roster is imported.

When the portal is served over HTTPS, start it with `COOKIE_SECURE=1` so sign-in cookies are
marked secure.

## Try it with fictional data

`npm run demo` creates a separate `demo-data` folder with fictional staff, students and reports,
then starts the portal. Every demo account uses the password `Demo-Pass-2026`
(admin@demo.test, coordinator@demo.test, transport@demo.test, principal@demo.test,
student1@demo.test and so on). Never use the demo data for the real portal.

## Logo

Put the college's official logo file at `public/logo.png`. The header shows it automatically.
Until then a plain "SRM" text mark appears. Use the logo only with the college's permission.
To remove the "pilot" line in the footer once the college has authorised the portal, set
`PILOT_NOTICE` to an empty string at the top of `public/app.js`.

## Who can do what

| Role | Can do |
| --- | --- |
| Student | Register (roster-matched), submit one report per route per day, see own reports |
| Portal coordinator | See reports with student identity, remove false reports with a reason, enter the official alert and confirm the level, post advisory notices, draft attendance and leave notices |
| Transport in-charge | See route and area totals, post transport notices |
| Principal | See totals, approve or reject attendance and leave notices, post any notice, read the audit log |
| Administrator | Manage staff accounts, the roster and settings, read the audit log |

## Rules built in

- One report per student per route per day.
- A route counts only when at least 3 different students report it (adjustable).
- The level is a suggestion until the coordinator confirms it. Orange and Red need an official
  alert with a reference. Red needs an Orange or Red official alert.
- Attendance and leave notices stay hidden until the principal approves them.
- Public pages show the confirmed level, routes and notices only. No student names.
- Report removals, level confirmations, notices and account changes are in the audit log.

## Checks

`npm test` runs the rule checks against a temporary database.

## Limits to know about

- The portal does not send email, so it cannot confirm that a student owns the college email.
  Registration relies on the register number and email both matching the roster. Adding email
  verification needs a mail service.
- It uses one Postgres file in `data/`. Back that folder up. It suits one college server.
- The starting area list and the thresholds are placeholders. The college should set them.
- Tamil language support and a weather-service feed are not included. The coordinator enters
  the IMD or Greater Chennai Corporation alert by hand.
- "PDF summary" is the Summary report page: use the browser's Print, then Save as PDF.
- Collecting student addresses is personal data. The college's IT or legal team should confirm
  the consent text and retention against India's data protection law before launch.

## Deploy on Vercel with a Supabase database

All data (accounts, roster, reports, photos, notices, audit log) lives in Supabase Postgres, so nothing is lost on a restart or redeploy.

1. **Supabase:** create a project. Choose a region near Chennai (Mumbai or Singapore) and set a strong database password.
2. In the project press **Connect**, choose **Transaction pooler**, and copy the URI (port 6543). Replace `[YOUR-PASSWORD]` with the database password. This is your `DATABASE_URL`.
3. **Vercel:** Add New, Project, import the GitHub repository. Leave the build settings alone (`vercel.json` sets them).
4. Before the first deploy, add these environment variables in Vercel (Settings, Environment Variables):

| Name | Value |
|---|---|
| `DATABASE_URL` | the Supabase pooler URI from step 2 |
| `COOKIE_SECURE` | `1` |
| `TRUST_PROXY` | `1` |
| `ADMIN_NAME` | name of the first administrator |
| `ADMIN_EMAIL` | email of the first administrator |
| `ADMIN_PASSWORD` | at least 10 characters. Change it on the Password page after the first sign-in. |

5. Deploy. The tables are created automatically on the first request, and the administrator is created from the `ADMIN_*` values when none exists.
6. Sign in at `/staff-login.html`, import the student roster and the approved staff list, and the portal is ready.

Tables have row security switched on with no policies, so Supabase's public web API returns nothing. Only the server's own database login can read the data. Never put the database password or the Supabase service key in the web pages.

## Run locally

`npm install`, then `npm run demo` starts the portal with fictional demo data in an embedded Postgres (PGlite) under `demo-data/`. `npm test` runs the rule tests. Set `DATABASE_URL` to a local Postgres to test against a real server.

## Photo checks

A report may include one photo. The page reads the camera data (EXIF) from the original file and sends it with the shrunk picture; the server checks it (`exif.js`):

- **Rejected:** the file was saved by a photo editor (Photoshop, Snapseed and similar) or is labelled as AI-made (generator names, "trainedAlgorithmicMedia" content credentials).
- **Verified:** camera make and model, a date within the last 24 hours, and a GPS location within 35 km of the college. Only verified photos add the photo weight to a route's score.
- **Not verified:** anything else (no location, old photo, screenshot, PNG). The report still counts, without the photo weight, and the student is told why.

The coordinator sees the status, the notes and the photo location. Limits: metadata can be rewritten with free tools and is not tied to the picture itself, so this stops casual fakes only. The coordinator stays the final check. Centre, radius and age are in `photoCheck` in `db.js`.
