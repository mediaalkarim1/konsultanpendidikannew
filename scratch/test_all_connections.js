import fs from 'fs';
import path from 'path';

// Read .env file manually
let SUPABASE_URL = "https://muyugntbzspnincoaekj.supabase.co";
let SUPABASE_KEY = "sb_publishable_KHzSJnooFPXSFmwcL8yvpg_pHLzwSBK";

try {
  const envContent = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('VITE_SUPABASE_URL=')) {
      SUPABASE_URL = trimmed.split('=')[1].replace(/["']/g, '');
    }
    if (trimmed.startsWith('VITE_SUPABASE_PUBLISHABLE_KEY=')) {
      SUPABASE_KEY = trimmed.split('=')[1].replace(/["']/g, '');
    }
  }
} catch (e) {
  console.log("Catatan: Memakai URL & Key default dari konfigurasi proyek.");
}

console.log("=================================================");
console.log("   DIAGNOSTIK KONEKSI SISTEM (ALL SCHEMA TABLES)");
console.log("=================================================");
console.log(`📍 Target Supabase URL : ${SUPABASE_URL}`);
console.log(`🔑 Supabase Key        : ${SUPABASE_KEY.slice(0, 18)}...`);
console.log("-------------------------------------------------");

async function runDiagnostic() {
  const summary = [];
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };

  // 1. Check REST Endpoint
  try {
    const start = Date.now();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers });
    const elapsed = Date.now() - start;
    if (res.ok || res.status === 200 || res.status === 404) {
      console.log(`✅ [1] Supabase REST Server: ONLINE (HTTP ${res.status}) [${elapsed}ms]`);
      summary.push({ name: "Supabase REST Server", status: "OK", detail: `${res.status} ${res.statusText} (${elapsed}ms)` });
    } else {
      console.log(`⚠️ [1] Supabase REST Server: HTTP ${res.status}`);
      summary.push({ name: "Supabase REST Server", status: "WARN", detail: `HTTP ${res.status}` });
    }
  } catch (err) {
    console.log(`❌ [1] Supabase REST Server: GAGAL (${err.message})`);
    summary.push({ name: "Supabase REST Server", status: "FAILED", detail: err.message });
  }

  // 2. Check Auth Service
  try {
    const start = Date.now();
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers });
    const elapsed = Date.now() - start;
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      console.log(`✅ [2] Supabase Auth Service (GoTrue): ONLINE [${elapsed}ms]`);
      summary.push({ name: "Supabase Auth Service", status: "OK", detail: `Healthy v${json.version || '2.x'} (${elapsed}ms)` });
    } else {
      console.log(`⚠️ [2] Supabase Auth Service: HTTP ${res.status}`);
      summary.push({ name: "Supabase Auth Service", status: "WARN", detail: `HTTP ${res.status}` });
    }
  } catch (err) {
    console.log(`❌ [2] Supabase Auth Service: GAGAL (${err.message})`);
    summary.push({ name: "Supabase Auth Service", status: "FAILED", detail: err.message });
  }

  // 3. Database Table Connectivity Test (7 Core Schema Tables)
  const actualTables = [
    'questions',
    'question_options',
    'consultations',
    'consultation_answers',
    'consultation_analysis',
    'settings',
    'user_roles'
  ];

  console.log("-------------------------------------------------");
  console.log("📊 Testing Database Tables (Real Schema):");

  for (const table of actualTables) {
    try {
      const start = Date.now();
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, {
        headers: {
          ...headers,
          'Prefer': 'count=exact'
        }
      });
      const elapsed = Date.now() - start;
      const contentRange = res.headers.get('content-range');

      if (res.ok) {
        const data = await res.json();
        const totalRows = contentRange ? contentRange.split('/')[1] : data.length;
        console.log(`   ✅ Table '${table}': TERHUBUNG (${totalRows} total baris) [${elapsed}ms]`);
        summary.push({ name: `Tabel '${table}'`, status: "OK", detail: `${totalRows} baris data (${elapsed}ms)` });
      } else {
        const errJson = await res.json().catch(() => ({ message: res.statusText }));
        const isRls = res.status === 401 || errJson.message?.includes('permission denied');
        if (isRls) {
          console.log(`   🔒 Table '${table}': RLS DILINDUNGI (Permission Denied / Needs Auth / Service Role) [${elapsed}ms]`);
          summary.push({ name: `Tabel '${table}'`, status: "TERPROTEKSI RLS", detail: `HTTP 401 - Terlindungi Security Policy` });
        } else {
          console.log(`   ❌ Table '${table}': HTTP ${res.status} - ${errJson.message || JSON.stringify(errJson)}`);
          summary.push({ name: `Tabel '${table}'`, status: "ERROR", detail: `HTTP ${res.status}: ${errJson.message || res.statusText}` });
        }
      }
    } catch (err) {
      console.log(`   ❌ Table '${table}': FAILED (${err.message})`);
      summary.push({ name: `Tabel '${table}'`, status: "FAILED", detail: err.message });
    }
  }

  // 4. External CDN & Services Check
  console.log("-------------------------------------------------");
  console.log("🌐 Testing External Endpoint & CDN Connections:");
  const externalServices = [
    { name: "Cloudflare Worker (OG Image)", url: "https://konsultanpendidikan.mediaalkarim1.workers.dev/og-image.png" },
    { name: "Google Fonts CDN", url: "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap" },
    { name: "Unsplash CDN (Media Assets)", url: "https://images.unsplash.com/photo-1488521787991-ed7bbaae773c?auto=format&fit=crop&w=800&q=80" }
  ];

  for (const ext of externalServices) {
    try {
      const start = Date.now();
      const res = await fetch(ext.url, { method: 'HEAD' });
      const elapsed = Date.now() - start;
      if (res.ok) {
        console.log(`   ✅ ${ext.name}: ONLINE (${res.status}) [${elapsed}ms]`);
        summary.push({ name: ext.name, status: "OK", detail: `Status ${res.status} (${elapsed}ms)` });
      } else {
        console.log(`   ⚠️ ${ext.name}: HTTP ${res.status}`);
        summary.push({ name: ext.name, status: "WARN", detail: `Status ${res.status}` });
      }
    } catch (err) {
      console.log(`   ❌ ${ext.name}: GAGAL (${err.message})`);
      summary.push({ name: ext.name, status: "FAILED", detail: err.message });
    }
  }

  console.log("=================================================");
  console.log("       HASIL AKHIR DIAGNOSTIK KONEKSI SISTEM     ");
  console.log("=================================================");
  summary.forEach(s => {
    const badge = s.status === "OK" ? "✅" : (s.status === "TERPROTEKSI RLS" ? "🔒" : "❌");
    console.log(`${badge} [${s.status}] ${s.name}: ${s.detail}`);
  });
  console.log("-------------------------------------------------");
}

runDiagnostic();
