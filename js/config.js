// Chosen Generation Rides: settings.
// Edit this file and commit it. Nothing in here is secret: the Supabase "anon" key is
// designed to be public, because the database rules (supabase/schema.sql) decide who
// can see what. NEVER paste the "service_role" key here.

export const CONFIG = {
  appName: "Chosen Generation Rides",
  churchName: "Chosen Generation Church",

  // 1) The church. Every pickup time is worked back from here, so pin it exactly:
  //    in Google Maps, right-click the church's front door, click the two numbers at the top
  //    of the menu (that copies them), and paste them as lat and lng below.
  //    Until then the app looks up the street address and shows the leader where it landed.
  church: { address: "601 Eastlake Avenue", lat: 52.119574, lng: -106.659182 },

  // One service only for now. Drivers are scheduled to ARRIVE arriveBeforeMin minutes before
  // the service. Each rider's "be ready by" time is worked out from the real route (their
  // pickup time minus readyBufferMin). Set readyBy to e.g. "10:45" only if you want a
  // fixed earliest-ready ceiling for everyone.
  service: { time: "11:45", arriveBeforeMin: 15, readyBy: null, readyBufferMin: 5 },

  // Matching limits (minutes). See README "Tuning the matching".
  // Safety margin on every drive between two stops: trafficPct % on top of the real road time
  // (traffic lights, slow streets, finding the house) plus legBufferMin minutes. If real road
  // times can't be loaded, estimatePct is used instead and the leader is warned.
  // stopMin = minutes waiting at each house while the rider comes out and gets in.
  matching: { stopMin: 3, unloadMin: 2, maxDetourMin: 35, maxRouteMin: 75, earliestPickup: "09:30", trafficPct: 20, estimatePct: 40, legBufferMin: 1 },

  // Texts the leader copies to ONE driver include each rider's address and phone, because the
  // driver is allowed to see them in the app anyway. Set to false to keep addresses out of texts.
  texts: { includeDetails: true },

  weeksAhead: 4,

  // 2) Leave both empty to run in DEMO mode (sample data, nothing saved to a server).
  //    Paste your Supabase project URL and anon key to go live.
  supabase: {
    url: "https://gpocgkxmglclvwxiqyrd.supabase.co",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdwb2Nna3htZ2xjbHZ3eGlxeXJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxMjY3MDAsImV4cCI6MjEwMzcwMjcwMH0.TCpYFz83C7aUQjFx0fXnBTjKDV0v6rDWuDCfC5TiZe4",
  },

  // Free services used from the browser when live. If they are unreachable the app
  // falls back to straight-line estimates and says so on the leader's screen.
  routing: { enabled: true, osrmUrl: "https://router.project-osrm.org" },
  geocoding: { enabled: true, nominatimUrl: "https://nominatim.openstreetmap.org", photonUrl: "https://photon.komoot.io" },
};

// Adding ?demo to the address opens the sample-data demo (fictional people, nothing saved),
// so the leader can look at every role without touching the real database.
const asksForDemo = typeof location !== "undefined" && /[?&]demo(=|&|$)/.test(location.search || "");
export const IS_DEMO = asksForDemo || !(CONFIG.supabase.url && CONFIG.supabase.anonKey);
