#!/usr/bin/env node
// Flags CloudCannon sites whose GitHub build/sync has failed (or gone stale).
// Reports per org and exits non-zero if any site is unhealthy.
//
// Usage: node test.js [org ...]
//        CLOUDCANNON_ORGS="my-org,another-org" node test.js
// 
// node test.js --access-key-id "ccu_..." --access-key-secret "..."
// CC_ACCESS_KEY_ID="ccu_…" CC_ACCESS_KEY_SECRET="…" node test.js
//
// Auth: provide a CloudCannon access key either via env vars or CLI flags.
//   CC_ACCESS_KEY_ID / CC_ACCESS_KEY_SECRET  (the CLI's native env vars)
//   --access-key-id=<id> --access-key-secret=<secret>
// If neither is supplied, the script falls back to whatever `cloudcannon login`
// already stored. Flags take precedence over env vars. Access keys are passed to
// the `cloudcannon` subprocess in-memory only; nothing is written to disk.

import { execFileSync } from "node:child_process";

// --- Config ---
// Orgs to check (names/IDs/UUIDs). CLI args and CLOUDCANNON_ORGS override this.
const ORGS = [
  "Tom's Demo Org",
];

const STALE_SYNC_DAYS = 7; // last_synced older than this => unhealthy
const FAIL_ON_STALE = true; // false => staleness is a warning, not a failure
// NOTE: we intentionally do NOT pass --items alongside --page. The CLI signs a
// request's query params in insertion order, but the API verifies the signature
// against a canonicalized (alphabetically sorted) query string. --page + --items
// goes out as page,items but is canonicalized to items,page, so the checksum
// never matches ("checksum: Must match"). Paginating with --page alone keeps it
// to a single param and authenticates fine; the API uses its default page size.
// ---

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const ANSI = /\x1b\[[0-9;]*m/g;

// Split argv into access-key flags and leftover positional org names.
// Supports both "--flag value" and "--flag=value" forms.
function parseArgs(argv) {
  const orgs = [];
  let accessKeyId;
  let accessKeySecret;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [name, inline] =
      arg.startsWith("--") && eq !== -1
        ? [arg.slice(0, eq), arg.slice(eq + 1)]
        : [arg, undefined];

    if (name === "--access-key-id") {
      accessKeyId = inline !== undefined ? inline : argv[(i += 1)];
    } else if (name === "--access-key-secret") {
      accessKeySecret = inline !== undefined ? inline : argv[(i += 1)];
    } else {
      orgs.push(arg);
    }
  }

  return { orgs, accessKeyId, accessKeySecret };
}

// CLI args > CLOUDCANNON_ORGS env > hardcoded ORGS.
function resolveOrgs(orgArgs) {
  if (orgArgs.length > 0) return orgArgs;

  const fromEnv = process.env.CLOUDCANNON_ORGS;
  if (fromEnv) {
    return fromEnv
      .split(",")
      .map(o => o.trim())
      .filter(Boolean);
  }

  return ORGS;
}

// Access key from CLI flags (win) or env vars. Returns { id, secret } where each
// may be undefined. Exits if exactly one half of the pair is supplied.
function resolveAccessKey({ accessKeyId, accessKeySecret }) {
  const id = accessKeyId ?? process.env.CC_ACCESS_KEY_ID;
  const secret = accessKeySecret ?? process.env.CC_ACCESS_KEY_SECRET;

  if (Boolean(id) !== Boolean(secret)) {
    console.error(
      "Both an access key ID and secret must be provided together (via " +
        "--access-key-id/--access-key-secret or CC_ACCESS_KEY_ID/CC_ACCESS_KEY_SECRET)."
    );
    process.exit(2);
  }

  return { id, secret };
}

// Child-process env with the access key injected (in-memory only). When no key
// is provided, the CLI falls back to its stored auth.json.
function buildChildEnv(accessKey) {
  const env = { ...process.env };
  if (accessKey.id && accessKey.secret) {
    env.CC_ACCESS_KEY_ID = accessKey.id;
    env.CC_ACCESS_KEY_SECRET = accessKey.secret;
  }
  return env;
}

// Fetch all sites for an org across pages. Throws on CLI/parse failure.
function fetchSites(org, env) {
  const sites = [];
  let page = 1;
  let totalPages = 1;

  do {
    const raw = execFileSync(
      "cloudcannon",
      ["orgs", "sites", "list", "--org", org, "--page", String(page)],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env }
    );

    const parsed = JSON.parse(raw.replace(ANSI, ""));
    if (!Array.isArray(parsed.items)) {
      throw new Error("unexpected response shape (no items array)");
    }

    sites.push(...parsed.items);
    totalPages = parsed.total_pages ?? 1;
    page += 1;
  } while (page <= totalPages);

  return sites;
}

// Return problems for a site (empty => healthy). `stale: true` marks a soft
// staleness warning vs a hard build/sync failure.
function evaluateSite(site) {
  const problems = [];

  if (site.sync_error) {
    problems.push({ stale: false, message: `sync failed: ${site.sync_error}` });
  }

  if (site.output_error) {
    problems.push({
      stale: false,
      message: `build/output error: ${site.output_error}`,
    });
  }

  if (
    site.last_compiled &&
    site.last_compiled_success &&
    new Date(site.last_compiled) > new Date(site.last_compiled_success)
  ) {
    problems.push({
      stale: false,
      message: `last build failed (compiled ${site.last_compiled} > last success ${site.last_compiled_success})`,
    });
  }

  if (site.last_synced) {
    const ageDays = (Date.now() - new Date(site.last_synced).getTime()) / MS_PER_DAY;
    if (ageDays > STALE_SYNC_DAYS) {
      problems.push({
        stale: true,
        message: `stale: last synced ${Math.floor(ageDays)} days ago`,
      });
    }
  }

  return problems;
}

function describeSite(site) {
  const repo = site.storage_provider_details?.full_name ?? "(no repo)";
  const domain = site.stable_domain ?? "(no domain)";
  return `${site.site_name} [${repo}] (${domain})`;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const orgs = resolveOrgs(parsed.orgs);
  const childEnv = buildChildEnv(resolveAccessKey(parsed));

  if (orgs.length === 0) {
    console.error(
      "No orgs to check. Set the ORGS array in test.js, pass org names as arguments, or set CLOUDCANNON_ORGS."
    );
    process.exit(2);
  }

  let hardFailures = 0;
  let staleWarnings = 0;

  for (const org of orgs) {
    console.log(`\n=== Org: ${org} ===`);

    let sites;
    try {
      sites = fetchSites(org, childEnv);
    } catch (err) {
      hardFailures += 1;
      console.log(`  ✗ Failed to list sites: ${err.message}`);
      continue;
    }

    const unhealthy = [];
    let healthy = 0;

    for (const site of sites) {
      const problems = evaluateSite(site);
      if (problems.length === 0) {
        healthy += 1;
      } else {
        unhealthy.push({ site, problems });
      }
    }

    console.log(`  ✓ ${healthy} healthy of ${sites.length} site(s)`);

    for (const { site, problems } of unhealthy) {
      const hard = problems.filter(p => !p.stale);
      const stale = problems.filter(p => p.stale);
      const marker = hard.length > 0 || FAIL_ON_STALE ? "✗" : "⚠";

      console.log(`  ${marker} ${describeSite(site)}`);
      for (const p of problems) {
        console.log(`      - ${p.message}`);
      }

      hardFailures += hard.length;
      staleWarnings += stale.length;
    }
  }

  console.log(
    `\nSummary: ${hardFailures} hard failure(s), ${staleWarnings} staleness warning(s).`
  );

  const failed = hardFailures > 0 || (FAIL_ON_STALE && staleWarnings > 0);
  process.exit(failed ? 1 : 0);
}

main();