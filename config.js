/* QNB Movie Night — shared client config
 *
 * SAFE TO COMMIT: the anon key is a public, RLS-gated key meant for browser code.
 * Never put the service_role key here or anywhere in this repo.
 */
window.QNB_CONFIG = {
  SUPABASE_URL: "https://bxznayvgzzvcnvfhwshc.supabase.co",
  // Legacy anon (JWT) key — public, row-level-security enforced.
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ4em5heXZnenp2Y252Zmh3c2hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNjU5MzYsImV4cCI6MjA5Njk0MTkzNn0.Kz5bWAPo7REm-rkIZNwnlH4hBq-f4sbEySmNaLpqYqo",

  // Cinema hall capacity (HEADS, not parties). Screen 1 fills to this, then Screen 2.
  // TODO: replace 127 with the real Screen 1 hall size when known.
  SCREEN_1_CAPACITY: 127,

  // Timezone used to render check-in times (event is in Doha).
  TIME_ZONE: "Asia/Qatar",

  // Dashboard gate — a simple shared key, NOT real security. See README.
  DASHBOARD_KEY: "qnb-movie-2026",
};
