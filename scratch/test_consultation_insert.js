import fs from 'fs';
import path from 'path';

let SUPABASE_URL = "https://muyugntbzspnincoaekj.supabase.co";
let SUPABASE_KEY = "sb_publishable_KHzSJnooFPXSFmwcL8yvpg_pHLzwSBK";

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function testInsert() {
  console.log("1. Testing insert with parent_name, child_name, whatsapp_number, level, status...");
  let res = await fetch(`${SUPABASE_URL}/rest/v1/consultations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parent_name: "Bpk. Budi Test",
      child_name: "Ananda Andi",
      whatsapp_number: "08123456789",
      level: "tksd",
      status: "Belum Diproses"
    })
  });
  let text = await res.text();
  console.log("Response 1 Status:", res.status, text);

  console.log("\n2. Testing insert without child_name (only parent_name, whatsapp_number, level, status)...");
  res = await fetch(`${SUPABASE_URL}/rest/v1/consultations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parent_name: "Bpk. Budi Test (Anak: Ananda Andi)",
      whatsapp_number: "08123456789",
      level: "tksd",
      status: "Belum Diproses"
    })
  });
  text = await res.text();
  console.log("Response 2 Status:", res.status, text);
}

testInsert();
