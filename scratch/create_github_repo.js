import fs from 'fs';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT;

if (!GITHUB_TOKEN) {
  console.error("❌ Token GITHUB_TOKEN tidak ditemukan.");
  process.exit(1);
}

async function createRepo() {
  console.log("==========================================");
  console.log("   MEMBUAT REPOSITORY GITHUB BARU        ");
  console.log("==========================================");
  console.log("Target Repo Name : konsultanpendidikannew");
  console.log("Account / Owner  : mediaalkarim1");

  const headers = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Antigravity-Agent'
  };

  // Try creating repo under authenticated user / org
  try {
    let url = 'https://api.github.com/user/repos';
    let res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'konsultanpendidikannew',
        description: 'Konsultan Pendidikan Al-Karim (New Version)',
        private: false,
        auto_init: false
      })
    });

    if (res.status === 422) {
      console.log("⚠️ Repository 'konsultanpendidikannew' sudah pernah dibuat di GitHub!");
    } else if (res.ok) {
      const data = await res.json();
      console.log(`✅ BERHASIL DIBUAT! URL: ${data.html_url}`);
    } else {
      // Try organization endpoint if mediaalkarim1 is an org
      console.log(`Respon user endpoint: ${res.status}. Mencoba endpoint organization 'mediaalkarim1'...`);
      url = 'https://api.github.com/orgs/mediaalkarim1/repos';
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'konsultanpendidikannew',
          description: 'Konsultan Pendidikan Al-Karim (New Version)',
          private: false,
          auto_init: false
        })
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`✅ BERHASIL DIBUAT DI ORGANISASI! URL: ${data.html_url}`);
      } else {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        console.error(`❌ GAGAL MEMBUAT REPO (${res.status}): ${err.message || JSON.stringify(err)}`);
      }
    }
  } catch (err) {
    console.error("❌ Terjadi kesalahan saat memanggil GitHub API:", err.message);
  }
}

createRepo();
