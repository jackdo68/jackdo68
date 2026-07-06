// Regenerates the "Languages" section of README.md using GitHub's own GraphQL API.
// Zero dependencies — uses Node's built-in fetch (Node 18+). Runs in GitHub Actions
// with the workflow's built-in GITHUB_TOKEN, so it uses *your* API rate-limit budget
// and never depends on a shared third-party image service.

import { readFile, writeFile } from "node:fs/promises";

const LOGIN = process.env.GH_LOGIN || "jackdo68";
const TOKEN = process.env.GITHUB_TOKEN;
const README = process.env.README_PATH || "README.md";
const TOP_N = Number(process.env.TOP_N || 10);
const BAR_WIDTH = 20;

// Languages to leave out of the breakdown (case-insensitive).
const EXCLUDE = new Set(
  (process.env.EXCLUDE || "html,css,javascript")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const START = "<!-- LANGUAGES:START -->";
const END = "<!-- LANGUAGES:END -->";

if (!TOKEN) {
  console.error("Missing GITHUB_TOKEN environment variable.");
  process.exit(1);
}

const QUERY = `
query($login: String!, $after: String) {
  user(login: $login) {
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        primaryLanguage { name }
        languages(first: 30, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
  }
}`;

async function fetchRepos() {
  const nodes = [];
  let after = null;
  do {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: QUERY, variables: { login: LOGIN, after } }),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
    const repos = json.data.user.repositories;
    nodes.push(...repos.nodes);
    after = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

function tally(repos) {
  const byRepo = new Map(); // language -> repo count (primary language)
  const byBytes = new Map(); // language -> total size in bytes

  for (const repo of repos) {
    const primary = repo.primaryLanguage?.name;
    if (primary && !EXCLUDE.has(primary.toLowerCase())) {
      byRepo.set(primary, (byRepo.get(primary) || 0) + 1);
    }
    for (const edge of repo.languages?.edges || []) {
      const name = edge.node.name;
      if (EXCLUDE.has(name.toLowerCase())) continue;
      byBytes.set(name, (byBytes.get(name) || 0) + edge.size);
    }
  }
  return { byRepo, byBytes };
}

function bar(fraction) {
  const filled = Math.round(fraction * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function renderTable(map, unitLabel) {
  const total = [...map.values()].reduce((a, b) => a + b, 0) || 1;
  const rows = [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([name, value]) => {
      const pct = (value / total) * 100;
      return `| \`${name}\` | ${unitLabel(value)} | \`${bar(value / total)}\` | ${pct.toFixed(1)}% |`;
    });
  return [
    `| Language | ${unitLabel.header} | Share | |`,
    `| :-- | --: | :-- | --: |`,
    ...rows,
  ].join("\n");
}

const repoUnit = (n) => `${n}`;
repoUnit.header = "Repos";
const byteUnit = (n) => {
  const kb = n / 1024;
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
};
byteUnit.header = "Size";

const DISPLAY_NAMES = { html: "HTML", css: "CSS", javascript: "JavaScript" };
const displayName = (s) =>
  DISPLAY_NAMES[s] || s.charAt(0).toUpperCase() + s.slice(1);

function buildSection({ byRepo, byBytes }) {
  const excluded = [...EXCLUDE].map(displayName).join(", ");
  const note = excluded ? ` _(excludes ${excluded})_` : "";
  const stamp = new Date().toISOString().slice(0, 10);
  return [
    START,
    "",
    `**Top Languages by Repo**${note}`,
    "",
    renderTable(byRepo, repoUnit),
    "",
    `**Top Languages by Code Size**${note}`,
    "",
    renderTable(byBytes, byteUnit),
    "",
    `<sub>🔄 Auto-updated ${stamp} via GitHub Actions.</sub>`,
    "",
    END,
  ].join("\n");
}

async function main() {
  const repos = await fetchRepos();
  const section = buildSection(tally(repos));

  let md = await readFile(README, "utf8");
  const startIdx = md.indexOf(START);
  const endIdx = md.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Could not find ${START} / ${END} markers in ${README}.`);
  }
  const before = md.slice(0, startIdx);
  const after = md.slice(endIdx + END.length);
  const next = before + section + after;

  if (next === md) {
    console.log("No changes to Languages section.");
    return;
  }
  await writeFile(README, next);
  console.log("Updated Languages section.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
