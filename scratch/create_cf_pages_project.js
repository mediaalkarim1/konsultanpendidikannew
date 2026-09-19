const ACCOUNT_ID = "356fdc81a9381951815bdaa88607d98e";
const OAUTH_TOKEN = "cfoat_lGZKDnYlVFPV9CFCe6gU1SJbmaoc4qTFcQ2pTxutHog.8fPgfO4YD9NaSPOdAh3TZOHOCu3ea_mPOaVvrcJDYnk";

async function createPagesProject() {
  console.log("==================================================");
  console.log("  CREATING CLOUDFLARE PAGES PROJECT VIA API       ");
  console.log("==================================================");

  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects`;
  const headers = {
    'Authorization': `Bearer ${OAUTH_TOKEN}`,
    'Content-Type': 'application/json'
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'konsultanpendidikan',
        production_branch: 'main'
      })
    });

    const data = await res.json();
    console.log(`API Response Status: ${res.status}`);
    console.log(JSON.stringify(data, null, 2));

    if (res.ok || data.success) {
      console.log(`✅ PROJECT PAGES BERHASIL DIBUAT! Domain: https://konsultanpendidikan.pages.dev`);
    } else {
      console.log(`⚠️ Status: ${data.errors ? JSON.stringify(data.errors) : res.statusText}`);
    }
  } catch (err) {
    console.error("Error creating Pages project:", err.message);
  }
}

createPagesProject();
