# Chosen Generation Rides

Sunday rides to **Chosen Generation Church** (Saskatoon). Riders ask for a lift, drivers say how many seats they have, and the transport leader approves a plan the app drafts. It is a stopgap until the church has a van.

*Nobody in this church walks alone, including to the front door.*

**Everything here is free to run:** a static website on GitHub Pages, a free Supabase database, and free OpenStreetMap services for maps. No texting service is needed. The app writes the messages and the leader copies them into the group chat.

## What it does

| Who | Can do |
|---|---|
| **Rider** | Ask for any of the next 4 Sundays (optionally "ride home too"); opt in to a weekly check-in; see driver name, phone, car, pickup time and "be ready by" time once approved; "I can't make it" |
| **Driver** | Set seats, every-week or week-by-week availability, second trip; see an ordered pickup list with addresses, notes and a Google Maps route; "I can't make it" |
| **Leader** (who can also drive: My driving tab) | See requests vs seats; draft the plan; move people by hand; approve; approve and clear drivers (you do the vetting); add riders who phoned in; reassign in one click when a driver cancels; copy ready-made texts |

**Matching.** Each rider goes to the car where they add the fewest minutes on the way to church (real road times from OpenStreetMap routing, straight-line estimate if that's unreachable). Priority riders go first. Seats are the real limit, so drivers can offer a second trip, and anyone left goes on a waiting list **with the reason written out**.

**Groups.** A rider can say how many people are coming with them; each needs a seat. They're also asked if it's OK to split the group across cars. If yes, the app fills cars one after another (fewest cars first); each driver sees "picking up 3 of a group of 7" and the rider sees every driver and time. If they said keep us together and no single car fits, they go on the waiting list with the reason, and a button, "They agree to be split across cars", lets you re-place just that group after you've asked them. Anyone who can't be seated stays on the waiting list with the number of seats still needed.

**Times.** Drivers are scheduled to arrive 15 minutes before the 11:45 service (11:30). Pickup times are worked backward from that along each route; each rider's "be ready by" time is their pickup minus 5 minutes. Change either in `js/config.js`, or set `readyBy: "10:45"` for a fixed ceiling.

**Weekly rhythm.** Thursday: copy the check-in text to the group (opt-in riders; silence means no ride). Saturday noon: requests close. Then draft, review, approve, copy texts. Drivers and riders see nothing until you approve.

## Safety and privacy (enforced by the database, `supabase/schema.sql`)

- **Vetting is done by the transport leader**, outside the app (licence, insurance, police check, whatever the church requires). A new driver is "pending" and gets no riders until you set them to **cleared** under People → Edit. The database refuses to save a plan with an uncleared driver. Licence, insurance and check-date fields are optional notes for your own records and don't block anyone.
- **Under-18** riders are marked with a badge and only go with a driver you've cleared. (No guardian details are collected.)
- A rider's address and phone are visible only to the **leader and their assigned driver**, and only after approval. Riders see their driver's name, phone and car, not the driver's home address.
- Nobody can make themselves a leader, clear themselves as a driver, or edit their own check dates.
- **Text consent** is recorded with the date and the exact wording (CASL). The leader can record consent given by phone.
- Seats can't be exceeded in a saved plan.

## Try it now (demo mode)

Open the site. With no Supabase keys in `js/config.js` it runs in **demo mode** with made-up people and a "view as" switch. Nothing is saved. Demo plans use a **placeholder church location**.

Locally: `python3 -m http.server` in this folder, then open http://localhost:8000.

## Go live (about 30 minutes)

1. **Church location.** In `js/config.js`, set `church.address` (the app looks it up) or `church.lat` / `church.lng`. Until you do, the leader sees a warning and can't draft plans.
2. **Supabase.** Create a free project at supabase.com. SQL Editor → paste all of `supabase/schema.sql` → Run.
3. **Sign-in.** Authentication → Providers → Email is on by default (magic link, no password). Authentication → URL Configuration → set **Site URL** to your GitHub Pages address (`https://anyanso.github.io/cgc-rides/`).
4. **Keys.** Project Settings → API. Paste the **Project URL** and the **anon public** key into `supabase.url` and `supabase.anonKey` in `js/config.js`. Never paste the `service_role` key anywhere.
5. **Make yourself the leader.** Open the site, sign in with your email (this creates your login). Then in the SQL Editor run (your own email and name):

   ```sql
   insert into profiles (user_id, email, full_name, role)
   select id, email, 'Your Name', 'leader' from auth.users where email = 'you@example.com'
   on conflict (user_id) do update set role = 'leader';
   ```

   To hand over to a new coordinator, do the same for them and set your own role back to `rider`. No code changes.
6. **Publish.** Repo → Settings → Pages → Deploy from branch → `main` / root.

## Three-Sunday test plan

1. **Sunday 1:** 2 drivers and 3 to 4 riders you know. Clear the drivers once you've vetted them (People → Edit → status *cleared*). Run the whole weekly rhythm. Check every pickup time against a real drive.
2. **Sunday 2:** all drivers. Practise a driver tapping "I can't make it" and the leader pressing Reassign.
3. **Sunday 3:** the regular riders, with weekly check-in on.

Things to watch: pickup times vs reality (adjust `stopMin` and `maxDetourMin`), riders whose address couldn't be found, and whether drivers read their list.

## Tuning the matching (`js/config.js`)

`stopMin` minutes per pickup · `unloadMin` · `maxDetourMin` longest extra detour for one rider · `maxRouteMin` longest drive for one trip · `earliestPickup` · `arriveBeforeMin` · `readyBufferMin`.

## What is and isn't verified

`npm install && npm test` runs 58 tests: the matching engine (rules, second trips, waitlist, 150 riders), the privacy and safety rules **in a real Postgres** (PGlite), the demo store, every screen rendered for every role, and request building/parsing for routing and address lookup.

**Not tested from the build environment** (no outside network there): the real Supabase project and email sign-in, and the real OpenStreetMap routing and address services. Do the first live run yourself with the test plan above.

Known limits:
- Neighbourhood centres are hand-placed approximations (about 1 to 2 km) and are used only if an address can't be found; such riders show "Location approximate". Several neighbourhoods have no fallback and need a findable address.
- The free public routing server is a shared demo service meant for light use. If it fails, the app uses straight-line estimates and says so.
- Texts are copy-and-paste, not automatic.

## Later

Automatic texting (Twilio), rides home with a different driver, a church van as one large vehicle, live "driver is 5 minutes away".

## Layout

`index.html` · `css/styles.css` · `js/` (`matching.js` engine, `routing.js`, `geo.js`, `planner.js`, `texts.js`, `views.js`, `app.js`, `store-demo.js`, `store-live.js`, `config.js`) · `supabase/schema.sql` · `tests/`


## Looking at every role without touching real data

Add `?demo` to the site address (for example `https://anyanso.github.io/cgc-rides/?demo`) to open the sample-data demo. It uses fictional people, saves nothing, and lets you view the app as the leader, a driver or a rider.

## Keeping a copy and keeping Supabase awake

- **People tab → Keep a copy:** "Download people list" gives a spreadsheet (CSV); "Download full backup" gives a JSON file of every table. Both contain addresses and phone numbers, so keep them private. Do this about once a month and before big changes.
- **Keep-alive:** `.github/workflows/keepalive.yml` pings the database once a day so the free project never pauses. GitHub turns scheduled jobs off after 60 days with no repository changes; if you get that email, open the repository's **Actions** tab and click **Enable workflow**. You can also run it by hand from there (**Run workflow**).

## Removing a test person

People tab → **Edit** on a rider or driver → **Remove** (at the bottom). It deletes them with their requests, availability and rides; any plan they were in goes back to a draft so you can redo and approve it. Leaders cannot be removed this way. Their sign-in email is kept, so if they sign in again they register again. This needs the latest `supabase/schema.sql` to be run once in the SQL Editor.

## Confirmed addresses and pickup times (added 20 Oct 2026)

- **Required on every profile:** full name, mobile phone (10 digits, saved as 306-555-0142), home address and postal code (saved as S7N 0A1).
- **Addresses must be confirmed.** While typing, the app suggests real Saskatoon addresses (Photon, OpenStreetMap data). Picking one fills in the postal code and neighbourhood. On save, the address is checked once more (Nominatim) and is accepted only if that exact house number is found. Confirmed addresses are saved with `geo_source = 'verified'`.
- **Nothing is matched or timed from a guess.** A rider or driver without a confirmed address is never placed in a car: riders go on the waiting list ("Home address not confirmed") and drivers are left out, both with the reason. People registered before this change see "Please confirm your home address" until they do. The leader can still save a phoned-in person with an unconfirmed address; they show an "Address not confirmed" badge.
- **The church.** Pickup times are worked back from the church. Pin its exact latitude and longitude in `js/config.js` (in Google Maps, right-click the front door and copy the two numbers). Until then the app looks up the street address and shows the leader where it landed, with a map link to check.
- **Times include a safety margin.** Each drive between two stops uses the real road time from OSRM plus 20% and 1 minute (`trafficPct`, `legBufferMin`), then 3 minutes at each house (`stopMin`), arriving 15 minutes before the service. If real road times can't be loaded, the straight-line guess gets 40% (`estimatePct`) and the leader is asked before approving.
- **Drivers see when to leave.** Each pickup list starts with "Leave home by …" (or "Leave church by …" for a second trip).
- **Database update:** run `supabase/update-2026-10-20-confirmed-addresses.sql` once in the Supabase SQL Editor (safe to run twice). New projects only need `schema.sql`.
- The address services are free and need no key; they are called from each person's browser. They were not reachable from the build environment, so their answers were tested with sample replies in their documented formats (`tests/addresses.test.mjs`). Try a few real addresses after updating.

## Team roles (added 20 Oct 2026)

One **supervisor** and up to two leaders (Leader and Assistant leader). Only the supervisor can
make a signed-in person a leader, move a leader back to driver or rider, or hand the supervisor
role over (People → Team). The database enforces this and logs every change (`team_log`).
If a supervisor ever leaves without handing over, someone with the Supabase login can make a new
one in the SQL Editor:

```sql
update profiles set is_supervisor = false where is_supervisor;
update profiles set role = 'leader', is_supervisor = true, leader_title = 'Supervisor'
 where lower(email) = lower('new.supervisor@example.com');
```

## Phone notifications (added 21 Oct 2026)

People tap **Allow notifications** once per device. They are pinged when:
- riders: their ride is confirmed or changes (sent when a leader approves the plan);
- drivers: their route is ready or changes, or they're asked for a last-minute ride;
- leaders: a new alert, or a new driver waiting for approval.

iPhones only allow this from the home-screen app (Share → Add to Home Screen, iOS 16.4+); the app
shows iPhone users how. Messages wait in `push_queue`; the **send-push** Edge Function
(`supabase/functions/send-push/index.ts`, no libraries) sends them with the Web Push standard and is
called by the app after each change. `sw.js` only shows notifications; it caches nothing.

Setup, once: run the SQL update; in Supabase → Edge Functions, create `send-push` and paste the
file; add the secrets `VAPID_PUBLIC_KEY` (same as `push.publicKey` in `js/config.js`) and
`VAPID_PRIVATE_KEY`. To make a new key pair: `node -e "const k=require('crypto').createECDH('prime256v1');k.generateKeys();console.log(k.getPublicKey('base64url'),k.getPrivateKey('base64url'))"`
(then update both places; everyone has to allow notifications again).

Leaders also see **Signed in but not registered**: people who entered their email and code but
never filled in their details, with a reminder message to copy.
