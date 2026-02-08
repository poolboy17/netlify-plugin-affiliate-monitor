/**
 * netlify-plugin-affiliate-link-monitor
 *
 * Scans built HTML for affiliate tracking URLs and validates each one.
 * If a link is broken (non-200, timeout, error), auto-replaces it with
 * a fallback URL so visitors never hit a dead page.
 *
 * Features:
 *   - Extracts all unique affiliate URLs from built HTML
 *   - HEAD requests to validate each (with timeout + retry)
 *   - Auto-replaces broken links with fallback URL in the built HTML
 *   - Deduplicates checks (each unique URL tested once)
 *   - Reports all results in deploy log
 *   - Optionally fails the build to trigger email notification
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const DEFAULTS = {
  // Pattern to match affiliate URLs (regex string)
  affiliatePattern: "nationalcouncilonstrength\\.sjv\\.io",
  // Fallback URL when a link is broken
  fallbackUrl: "https://nationalcouncilonstrength.sjv.io/certfit-home",
  // Fallback link text label (for the report)
  fallbackLabel: "NCSF Homepage",
  // Request timeout in ms
  timeoutMs: 10000,
  // Number of retries for failed requests
  retries: 2,
  // Fail the build if broken links are found (triggers Netlify email)
  failOnBroken: false,
  // Also check non-affiliate external links
  checkExternal: false,
};

// ── HTTP checker ─────────────────────────────────────────

function checkUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    const protocol = url.startsWith("https") ? https : http;

    const req = protocol.request(
      url,
      { method: "HEAD", timeout: timeoutMs, headers: { "User-Agent": "NetlifyAffiliateLinkMonitor/1.0" } },
      (res) => {
        // Follow redirects manually to check final destination
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          resolve({
            status: res.statusCode,
            redirectTo: res.headers.location,
            ok: true, // redirects are generally fine for affiliate links
          });
        } else {
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 400,
          });
        }
      }
    );

    req.on("error", (err) => {
      resolve({ status: 0, ok: false, error: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, ok: false, error: "timeout" });
    });

    req.end();
  });
}

async function checkUrlWithRetry(url, timeoutMs, retries) {
  let lastResult;
  for (let i = 0; i <= retries; i++) {
    lastResult = await checkUrl(url, timeoutMs);
    if (lastResult.ok) return lastResult;
    // Wait before retry
    if (i < retries) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  return lastResult;
}

// ── HTML scanning ────────────────────────────────────────

function extractAffiliateLinks(html, pattern) {
  const results = [];
  const re = new RegExp(`href=["'](https?://[^"']*${pattern}[^"']*)["']`, "gi");
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push(m[1]);
  }
  return results;
}

// ── Main plugin ──────────────────────────────────────────
module.exports = {
  onPostBuild: async ({ constants, utils, inputs }) => {
    const publishDir = constants.PUBLISH_DIR;
    const config = { ...DEFAULTS, ...inputs };
    const affiliateRe = new RegExp(config.affiliatePattern, "i");

    console.log("\n🔗 Affiliate Link Monitor — checking tracking URLs...\n");

    // 1. Find all HTML files
    const htmlFiles = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".html")) htmlFiles.push(full);
      }
    }
    walk(publishDir);

    // 2. Extract all unique affiliate URLs and track which files use them
    const urlFileMap = {}; // url → [file paths]
    const allUrls = new Set();

    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, "utf-8");
      const links = extractAffiliateLinks(html, config.affiliatePattern);
      for (const url of links) {
        allUrls.add(url);
        if (!urlFileMap[url]) urlFileMap[url] = [];
        urlFileMap[url].push(file);
      }
    }

    const uniqueUrls = [...allUrls];
    console.log(`   Found ${uniqueUrls.length} unique affiliate URLs across ${htmlFiles.length} pages\n`);

    if (uniqueUrls.length === 0) {
      console.log("   No affiliate links found. Nothing to check.\n");
      return;
    }

    // 3. Check each unique URL
    const results = [];
    let brokenCount = 0;

    for (const url of uniqueUrls) {
      process.stdout.write(`   Checking: ${url.substring(0, 70)}... `);
      const result = await checkUrlWithRetry(url, config.timeoutMs, config.retries);

      const entry = {
        url,
        ...result,
        filesUsing: urlFileMap[url].length,
        replaced: false,
      };

      if (!result.ok) {
        brokenCount++;
        entry.replaced = true;
        console.log(`❌ ${result.status || result.error}`);

        // Auto-replace in all files that use this URL
        for (const file of urlFileMap[url]) {
          let html = fs.readFileSync(file, "utf-8");
          // Replace all occurrences of the broken URL with fallback
          html = html.split(url).join(config.fallbackUrl);
          fs.writeFileSync(file, html, "utf-8");
        }
      } else {
        const statusInfo = result.redirectTo
          ? `${result.status} → ${result.redirectTo.substring(0, 50)}`
          : `${result.status}`;
        console.log(`✅ ${statusInfo}`);
      }

      results.push(entry);
    }

    // 4. Report
    console.log("\n═══════════════════════════════════════════");
    console.log("   AFFILIATE LINK REPORT");
    console.log("═══════════════════════════════════════════\n");
    console.log(`   Unique URLs checked:  ${uniqueUrls.length}`);
    console.log(`   Healthy:              ${uniqueUrls.length - brokenCount}`);
    console.log(`   Broken:               ${brokenCount}`);
    if (brokenCount > 0) {
      console.log(`   Auto-replaced:        ${brokenCount} (→ ${config.fallbackLabel})`);
    }
    console.log("");

    if (brokenCount > 0) {
      console.log("🔧 REPLACED LINKS:\n");
      for (const r of results.filter((r) => r.replaced)) {
        const reason = r.error || `HTTP ${r.status}`;
        console.log(`   ${r.url}`);
        console.log(`     Reason: ${reason}`);
        console.log(`     Used on: ${r.filesUsing} page(s)`);
        console.log(`     Replaced with: ${config.fallbackUrl}\n`);
      }

      console.log("📋 ACTION NEEDED: Update the broken URLs in your source code.");
      console.log("   The fallback URL is live now but earns less-targeted commissions.\n");
    }

    // Show all links summary
    console.log("───────────────────────────────────────────");
    console.log("   ALL AFFILIATE LINKS");
    console.log("───────────────────────────────────────────\n");
    for (const r of results) {
      const icon = r.ok ? "✅" : "🔧";
      const shortUrl = r.url.replace(/https?:\/\//, "").substring(0, 60);
      const pages = `${r.filesUsing} page${r.filesUsing > 1 ? "s" : ""}`;
      console.log(`   ${icon} ${shortUrl.padEnd(62)} ${pages}`);
    }
    console.log("");

    if (brokenCount === 0) {
      console.log("✅ All affiliate links are healthy!\n");
    }

    // 5. Optionally fail build to trigger email
    if (config.failOnBroken && brokenCount > 0) {
      const brokenList = results
        .filter((r) => r.replaced)
        .map((r) => `${r.url} (${r.error || "HTTP " + r.status})`)
        .join("\n  • ");
      utils.build.failBuild(
        `Affiliate Link Monitor: ${brokenCount} broken link(s) found and auto-replaced with fallback:\n  • ${brokenList}\n\nUpdate source URLs. Set failOnBroken: false to deploy without notification.`
      );
    }
  },
};
