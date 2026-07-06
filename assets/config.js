/* =========================================================
   CORE Management Ticketshop – Konfiguration
   Supabase-Backend aktivieren: beide Werte aus dem
   Supabase-Dashboard (Settings → API) hier eintragen.
   Solange die Felder leer sind, läuft der Shop im lokalen
   Demo-Modus (Daten nur im jeweiligen Browser).
   Der "anon key" ist öffentlich gedacht – die Daten sind
   über Row-Level-Security in der Datenbank geschützt.
   ========================================================= */
window.CM_CONFIG = {
  supabaseUrl: '',      // z. B. 'https://abcdefgh.supabase.co'
  supabaseAnonKey: ''   // 'eyJhbGciOi...'
};
