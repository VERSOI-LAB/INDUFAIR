// VERSOI — shared Supabase client. Include AFTER the supabase-js CDN <script>
// and BEFORE any page-specific script that uses `sb`.
(function () {
  var SUPABASE_URL = 'https://rqjfergjfhcrcuvfuhkm.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_RdtDN6VAPjOikX0CS-oT4A___yzI5w2';

  if (!window.supabase || !window.supabase.createClient) {
    console.error('[VERSOI] supabase-js not loaded — include the CDN script before supabase-client.js');
    return;
  }

  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
})();
