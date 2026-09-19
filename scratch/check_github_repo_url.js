async function checkRepos() {
  console.log("Checking public repositories of mediaalkarim1...");
  try {
    const res = await fetch('https://api.github.com/users/mediaalkarim1/repos?sort=updated&per_page=10', {
      headers: { 'User-Agent': 'Antigravity-Agent' }
    });
    if (res.ok) {
      const repos = await res.json();
      console.log(`Found ${repos.length} recent repositories:`);
      repos.forEach(r => console.log(` - ${r.name} (${r.html_url})`));
    } else {
      console.log(`HTTP ${res.status} when checking user repos.`);
      // Check org endpoint
      const orgRes = await fetch('https://api.github.com/orgs/mediaalkarim1/repos?sort=updated&per_page=10', {
        headers: { 'User-Agent': 'Antigravity-Agent' }
      });
      if (orgRes.ok) {
        const orgRepos = await orgRes.json();
        console.log(`Found ${orgRepos.length} org repositories:`);
        orgRepos.forEach(r => console.log(` - ${r.name} (${r.html_url})`));
      }
    }

    // Check specific target repo URL
    const targetRes = await fetch('https://api.github.com/repos/mediaalkarim1/konsultanpendidikannew', {
      headers: { 'User-Agent': 'Antigravity-Agent' }
    });
    console.log(`Target Repo API Status: ${targetRes.status} (${targetRes.statusText})`);
  } catch (err) {
    console.error("Error checking repos:", err.message);
  }
}

checkRepos();
