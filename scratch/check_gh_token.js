import fs from 'fs';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT;

console.log("Checking GitHub Token in Environment...");
if (GITHUB_TOKEN) {
  console.log("Found GITHUB_TOKEN in environment:", GITHUB_TOKEN.slice(0, 8) + "...");
} else {
  console.log("No GITHUB_TOKEN environment variable found.");
}
