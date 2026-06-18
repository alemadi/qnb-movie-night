// Public Supabase config — safe to commit and serve to the browser.
// The anon key is deliberately public: Row Level Security blocks every table
// read/write, and all guest access goes through the verify_guest / check_in
// RPCs. The service-role key is NEVER placed here (it lives only in .env for
// the importer).
window.QNB_CONFIG = {
  SUPABASE_URL: "https://tomfokjerpwoxgiqtdkd.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvbWZva2plcnB3b3hnaXF0ZGtkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MzM2MTAsImV4cCI6MjA5NzMwOTYxMH0.7Ltkll4530LztjjQ524pTtodYlwzgYUjAlPgaHBdT8I",
};
