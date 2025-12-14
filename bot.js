import { chromium } from "@playwright/test";
import fetch from "node-fetch";

const WP_BASE = (process.env.WP_BASE || "").replace(/\/$/, "");
const BOT_TOKEN = process.env.BOT_TOKEN || "SH_Fatih1706@";

if (!WP_BASE) {
  console.error("ENV eksik: WP_BASE");
  process.exit(1);
}

const PUSH_ENDPOINT = `${WP_BASE}/wp-json/silifke/v1/push`;

const SOURCES = [
  { name: "Mersin Emniyet", list: "https://www.mersin.pol.tr/haberler", host: "www.mersin.pol.tr" },
  { name: "Mersin İl Jandarma", list: "https://mersin.jandarma.gov.tr/haberler", host: "mersin.jandarma.gov.tr" }
];

function clean(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

function esc(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanTitle(title) {
  return clean(title)
    .replace(/^Mersin\s+İl\s+Emniyet\s+Müdürlüğü\s*[-–—:|]\s*/i, "")
    .replace(/^Mersin\s+Emniyet\s+Müdürlüğü\s*[-–—:|]\s*/i, "")
    .replace(/^Mersin\s+İl\s+Jandarma\s+Komutanlığı\s*[-–—:|]\s*/i, "")
    .replace(/^Mersin\s+Jandarma\s+Komutanlığı\s*[-–—:|]\s*/i, "")
    .replace(/^Mersin\s+Jandarma\s*[-–—:|]\s*/i, "")
    .replace(/^Basın\s+Duyurusu\s*[-–—:|]\s*/i, "")
    .trim();
}

/** WP’de aynı kaynak linki daha önce var mı? */
async function wpAlreadyPosted(sourceUrl) {
  try {
    const q = encodeURIComponent(sourceUrl);
    const r = await fetch(`${WP_BASE}/wp-json/wp/v2/posts?search=${q}&per_page=10`);
    const j = await r.json();
    if (!Array.isArray(j)) return false;
    return j.some(p => (p?.content?.rendered || "").includes(sourceUrl));
  } catch {
    return false;
  }
}

async function pushDraftToWp({ title, html, image, source }) {
  const r = await fetch(PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bot-token": BOT_TOKEN
    },
    body: JSON.stringify({
      title,
      content: html,
      image: image || "",
      source: source || ""
    })
  });

  let j = null;
  try { j = await r.json(); } catch {}

  if (!r.ok) {
    console.log("WP PUSH HATA:", r.status, j || {});
    return null;
  }
  return j?.post_id || null;
}

/** Liste sayfasından detay linklerini topla (iki site için ortak) */
async function getNewsLinks(page, listUrl, host) {
  await page.goto(listUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  // Link adayları
  const hrefs = await page.$$eval("a[href]", as =>
    as.map(a => a.getAttribute("href") || "").filter(Boolean)
  );

  const baseUrl = page.url();
  const links = [];
  const seen = new Set();

  for (let h of hrefs) {
    // absolute
    if (h.startsWith("/")) h = new URL(h, baseUrl).toString();
    if (!h.startsWith("http")) continue;

    try {
      const u = new URL(h);
      if (u.host !== host) continue;
      if (u.pathname === "/haberler" || u.pathname === "/haberler/") continue;

      // detay gibi görünmeyenleri ele
      const looksDetail =
        u.pathname.includes("merkezicerik") ||
        /\d{2}[-/.]\d{2}[-/.]\d{4}/.test(u.pathname) ||
        u.pathname.split("/").filter(Boolean).length >= 2;

      if (!looksDetail) continue;

      if (!seen.has(h)) {
        seen.add(h);
        links.push(h);
      }
    } catch {}
  }

  return links.slice(0, 15);
}

async function pickImage(page) {
  // 1) og:image
  try {
    const og = await page.locator('meta[property="og:image"]').first().getAttribute("content");
    if (og) return og;
  } catch {}

  // 2) twitter:image
  try {
    const tw = await page.locator('meta[name="twitter:image"]').first().getAttribute("content");
    if (tw) return tw;
  } catch {}

  // 3) img src / data-src / data-original
  try {
    const img = page.locator("article img, main img, img").first();
    let src = await img.getAttribute("src");
    if (!src) src = await img.getAttribute("data-src");
    if (!src) src = await img.getAttribute("data-original");
    if (src && src.startsWith("/")) src = new URL(src, page.url()).toString();
    return src || "";
  } catch {
    return "";
  }
}

async function scrapeDetail(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  // Title: h1 -> og:title -> <title>
  let title = "";
  try {
    title = await page.locator("h1").first().textContent();
  } catch {}

  if (!title) {
    try {
      title = await page.locator('meta[property="og:title"]').first().getAttribute("content");
    } catch {}
  }

  if (!title) {
    try { title = await page.title(); } catch {}
  }

  title = cleanTitle(title || "");

  // Content: main/article öncelik
  let text = "";
  try {
    const candidates = ["article", "main", ".content", ".icerik", ".page-content"];
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        const t = clean(await loc.innerText().catch(() => ""));
        if (t && t.length > 150) { text = t; break; }
      }
    }
    if (!text) text = clean(await page.locator("body").innerText());
  } catch {
    text = "";
  }

  if (text.length > 7000) text = text.slice(0, 7000);

  const image = await pickImage(page);

  // HTML’e çevir (paragraflı)
  const paras = text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map(p => clean(p))
    .filter(p => p.length >= 20)
    .slice(0, 20);

  const html = paras.length
    ? paras.map(p => `<p>${esc(p)}</p>`).join("")
    : `<p>${esc(text)}</p>`;

  return { title, html, image };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (compatible; SilifkeHaberBot/1.0)"
  });

  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);

  for (const src of SOURCES) {
    console.log("Liste:", src.list);
    const links = await getNewsLinks(page, src.list, src.host);
    console.log("Bulunan aday:", links.length);

    for (const link of links) {
      if (await wpAlreadyPosted(link)) continue;

      console.log("Detay:", link);
      const d = await scrapeDetail(page, link);

      // Görsel mutlaka olsun istedin: görselsiz geç
      if (!d.title || !d.image) {
        console.log("⛔ Atlandı (başlık/görsel yok):", link);
        continue;
      }

      const postId = await pushDraftToWp({
        title: d.title,
        html: d.html,
        image: d.image,
        source: link
      });

      if (postId) console.log("📝 Taslak eklendi:", postId);
    }
  }

  await browser.close();
})();
