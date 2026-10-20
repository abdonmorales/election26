// Git + GitHub helpers for the election-night loop (the one-shot workflow commits in YAML).
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Commit the given files if they changed; rebase onto the remote and push. Returns true if pushed. */
export function commitAndPush(files, message, branch) {
  git("add", "--", ...files);
  if (!git("diff", "--cached", "--name-only")) return false;
  git("commit", "-m", message);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      git("pull", "--rebase", "origin", branch);
      git("push", "origin", `HEAD:${branch}`);
      return true;
    } catch (err) {
      if (attempt === 4) throw err;
      execFileSync("sleep", [String(2 ** attempt)]);
    }
  }
  return false;
}

/** Ask GitHub to run the Pages workflow. workflow_dispatch is allowed from GITHUB_TOKEN. */
export async function dispatchPages(branch) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL = "https://api.github.com" } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return false;
  const res = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/pages.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: branch }),
  });
  if (!res.ok) throw new Error(`Pages dispatch failed: HTTP ${res.status} ${await res.text()}`);
  return true;
}
