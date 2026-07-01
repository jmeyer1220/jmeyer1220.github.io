#!/usr/bin/env node
/**
 * Sightline alignment validator — cache bust, BDR frontmatter, force tags, footer URLs.
 * Exit 0 on pass, 1 on errors. Warnings do not fail the run.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const errors = [];
const warnings = [];

const HTML_WITH_STYLE = [
  "index.html",
  "design-system/index.html",
  "sightline/index.html",
  "sightline-lived-out/index.html",
  "seam-field-guide/index.html",
  "verdict/index.html",
  "verdict/mca/index.html",
];

const SITE_PAGES = [...HTML_WITH_STYLE];

const SECONDARY_PAGES = [
  "design-system",
  "sightline",
  "sightline-lived-out",
  "seam-field-guide",
  "verdict",
  "verdict/mca",
];

const FORCE_TAG_SELECTORS = [".work-force.sl", ".work-force.tc", ".work-force.cd"];

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function exists(file) {
  return fs.existsSync(path.join(ROOT, file));
}

function error(msg) {
  errors.push(msg);
}

function warn(msg) {
  warnings.push(msg);
}

function extractStyleVersion(html) {
  const m = html.match(/style\.css\?v=([^"'\s>]+)/);
  return m ? m[1] : null;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

function extractCssBlock(css, selector) {
  const idx = css.indexOf(selector);
  if (idx === -1) return null;
  const brace = css.indexOf("{", idx);
  if (brace === -1) return null;
  let depth = 0;
  for (let i = brace; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(brace + 1, i);
    }
  }
  return null;
}

function gitAvailable() {
  try {
    execSync("git rev-parse --git-dir", { cwd: ROOT, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function gitShow(file) {
  try {
    return execSync(`git show HEAD:${file}`, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function gitDiff(file) {
  try {
    return execSync(`git diff HEAD -- ${file}`, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

// --- A. style.css cache bust consistency ---
function checkCacheBust() {
  if (!exists("index.html")) {
    error("[cache-bust] Missing index.html");
    return;
  }
  const refV = extractStyleVersion(read("index.html"));
  if (!refV) {
    error("[cache-bust] No style.css?v= found in index.html");
    return;
  }

  for (const file of HTML_WITH_STYLE) {
    if (!exists(file)) {
      error(`[cache-bust] Missing HTML file: ${file}`);
      continue;
    }
    const v = extractStyleVersion(read(file));
    if (!v) {
      error(`[cache-bust] No style.css?v= found in ${file}`);
    } else if (v !== refV) {
      error(`[cache-bust] ${file} has v=${v}, expected v=${refV} (from index.html)`);
    }
  }
}

// --- B. style.css change vs version bump (warning) ---
function checkStyleCssGitWarning() {
  if (!gitAvailable() || !exists("style.css") || !exists("index.html")) return;

  const diff = gitDiff("style.css");
  if (!diff.trim()) return;

  const currentV = extractStyleVersion(read("index.html"));
  const committedIndex = gitShow("index.html");
  const committedV = committedIndex ? extractStyleVersion(committedIndex) : null;

  if (committedV && currentV === committedV) {
    warn(
      `[cache-bust] style.css differs from HEAD but index.html still has ?v=${currentV} — bump version in all HTML files`
    );
  }
}

// --- C. BDR frontmatter sanity ---
function checkBdrFrontmatter() {
  const bdrDir = path.join(ROOT, "sightline-brand-system", "bdr");
  if (!fs.existsSync(bdrDir)) {
    warn("[bdr] sightline-brand-system/bdr/ not found — skipping BDR checks");
    return;
  }

  const files = fs.readdirSync(bdrDir).filter((f) => f.endsWith(".md"));
  const idToFile = {};

  for (const file of files) {
    const content = read(path.join("sightline-brand-system", "bdr", file));
    const fm = parseFrontmatter(content);
    const rel = `sightline-brand-system/bdr/${file}`;

    if (!fm) {
      error(`[bdr] Missing frontmatter: ${rel}`);
      continue;
    }
    if (!fm.id) error(`[bdr] Missing id: in ${rel}`);
    if (!fm.status) error(`[bdr] Missing status: in ${rel}`);
    if (fm.id) idToFile[fm.id] = file;

    const supersededBy = fm.superseded_by;
    if (supersededBy && supersededBy !== "null") {
      const targetFile = idToFile[supersededBy];
      if (!targetFile) {
        const byName = files.find((f) => f.includes(supersededBy.replace("BDR-", "").toLowerCase()));
        if (!byName && !exists(path.join("sightline-brand-system", "bdr", `${supersededBy}.md`))) {
          error(`[bdr] ${rel} superseded_by: ${supersededBy} — target BDR file not found`);
        }
      }
    }
  }

  // Second pass: resolve superseded_by against full id map
  for (const file of files) {
    const content = read(path.join("sightline-brand-system", "bdr", file));
    const fm = parseFrontmatter(content);
    if (!fm) continue;
    const supersededBy = fm.superseded_by;
    if (supersededBy && supersededBy !== "null" && !idToFile[supersededBy]) {
      error(`[bdr] sightline-brand-system/bdr/${file} superseded_by: ${supersededBy} — no BDR with that id`);
    }
  }

  checkLockedBdrMentions(files);
}

function collectRepoTextOutsideBdr() {
  const chunks = [];
  function walk(dir, relBase) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === "node_modules" || ent.name === ".git") continue;
        if (rel === "sightline-brand-system/bdr") continue;
        walk(path.join(dir, ent.name), rel);
      } else if (/\.(html|css|md|js|json|yml|yaml|mdc)$/i.test(ent.name)) {
        try {
          chunks.push({ rel, text: fs.readFileSync(path.join(dir, ent.name), "utf8") });
        } catch {
          /* skip binary */
        }
      }
    }
  }
  walk(ROOT, "");
  return chunks;
}

function checkLockedBdrMentions(bdrFiles) {
  const outside = collectRepoTextOutsideBdr();
  const corpus = outside.map((o) => o.text).join("\n");

  for (const file of bdrFiles) {
    const content = read(path.join("sightline-brand-system", "bdr", file));
    const fm = parseFrontmatter(content);
    if (!fm || fm.status !== "locked") continue;

    const id = fm.id || "";
    const stem = file.replace(/\.md$/, "");
    const shortId = id.replace("BDR-", "");

    const mentioned =
      (id && corpus.includes(id)) ||
      corpus.includes(stem) ||
      (shortId && corpus.includes(shortId));

    if (!mentioned) {
      warn(`[bdr] Locked ${id || file} has no mention outside sightline-brand-system/bdr/`);
    }
  }
}

// --- D. Force tag token usage ---
function checkForceTagTokens() {
  if (!exists("style.css")) {
    error("[force-tag] style.css not found");
    return;
  }
  const css = read("style.css");
  const hexRe = /#([0-9a-fA-F]{3,8})\b/;

  for (const sel of FORCE_TAG_SELECTORS) {
    const block = extractCssBlock(css, sel);
    if (!block) {
      warn(`[force-tag] Selector ${sel} not found in style.css`);
      continue;
    }
    const hexes = block.match(hexRe);
    if (hexes) {
      error(`[force-tag] ${sel} contains raw hex (${hexes.join(", ")}) — use var(--c-*) tokens`);
    }
  }
}

// --- E. Design-system typography preview vs BDR-0026 light-surface accent ---
function checkDesignSystemTypographyPreview() {
  if (!exists("style.css")) return;

  const css = read("style.css");
  const accentBlock = extractCssBlock(css, "body.design-system .ds-type-sample-accent");
  if (!accentBlock) {
    warn("[ds-typography] body.design-system .ds-type-sample-accent not found in style.css");
    return;
  }

  const required = [
    ["font-style", "normal"],
    ["font-weight", "500"],
    ["font-optical-sizing", "auto"],
    ["letter-spacing", "0.01em"],
  ];

  for (const [prop, val] of required) {
    const re = new RegExp(`${prop}:\\s*${val.replace(".", "\\.")}`);
    if (!re.test(accentBlock)) {
      error(
        `[ds-typography] .ds-type-sample-accent missing ${prop}: ${val} — must match BDR-0026 light-surface accent profile (.work-force-obs)`
      );
    }
  }

  if (/font-style:\s*italic/.test(accentBlock)) {
    error(
      "[ds-typography] .ds-type-sample-accent uses font-style: italic on light surface — BDR-0026 requires normal"
    );
  }

  if (!accentBlock.includes("clamp(")) {
    error(
      "[ds-typography] .ds-type-sample-accent should use clamp() size matching .work-force-obs (BDR-0026)"
    );
  }

  if (exists("design-system/index.html")) {
    const dsHtml = read("design-system/index.html");
    if (!/BDR-0026/.test(dsHtml.split("Typography trio")[1]?.split("</div>")[0] || "")) {
      warn("[ds-typography] design-system/index.html typography trio block should cite BDR-0026 for light-surface accent");
    }
  }
}

// --- F. Footer / internal directory URLs ---
function checkFooterLinks() {
  const htmlSuffixRe = new RegExp(
    `href=["'][^"']*(?:${SECONDARY_PAGES.join("|")})\\.html`,
    "gi"
  );
  const noSlashRe = new RegExp(
    `href=["'](?:\\.\\./)?(?:${SECONDARY_PAGES.join("|")})["']`,
    "gi"
  );

  for (const file of SITE_PAGES) {
    if (!exists(file)) continue;
    const html = read(file);
    let m;
    while ((m = htmlSuffixRe.exec(html)) !== null) {
      error(`[footer-urls] ${file}: internal link uses .html suffix (${m[0]}) — use directory URL with trailing slash (BDR-0019)`);
    }
    while ((m = noSlashRe.exec(html)) !== null) {
      warn(`[footer-urls] ${file}: internal link missing trailing slash (${m[0]})`);
    }
  }
}

// --- Run ---
checkCacheBust();
checkStyleCssGitWarning();
checkBdrFrontmatter();
checkForceTagTokens();
checkDesignSystemTypographyPreview();
checkFooterLinks();

console.log("\n=== Sightline Alignment Validation ===\n");

if (warnings.length) {
  console.log(`Warnings (${warnings.length}):`);
  warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  console.log("");
}

if (errors.length) {
  console.log(`Errors (${errors.length}):`);
  errors.forEach((e) => console.log(`  ✗ ${e}`));
  console.log("\nFAIL — fix errors above.\n");
  process.exit(1);
}

console.log(warnings.length ? "PASS with warnings.\n" : "PASS — all checks OK.\n");
process.exit(0);
