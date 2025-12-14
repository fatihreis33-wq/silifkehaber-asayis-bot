import { chromium } from "@playwright/test";
import fetch from "node-fetch";

const WP_BASE = process.env.WP_BASE; // https://silifkehaber.com.tr
const BOT_TOKEN = process.env.BOT_TOKEN || "SH_Fatih1706@";

if (!WP_BASE) {
  console.error("ENV eksik: WP_BASE");
  process.exit(1);
}

const PUSH_ENDPOINT = `${WP_BASE.replace(/\/$/, "")}/wp-json/silifke/v1/push`;

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

/** WP’de aynı kaynağı daha önce ekledik mi? (içerikte kaynak linki arar) */
async function wpAlreadyPosted(sourceUrl) {
  try {
    const q = encodeURIComponent(sourceUrl);
    const r = await fetch(`${WP_BASE.replace(/\/$/, "")}/wp-json/wp/v2/posts?search=${q}&per_page=5`);
    const j = await r.json();
    if (!Array.isArray(j)) return false;
    return j.some(p => (p?.content?.rendered || "").includes(sourceUrl));
  } catch {
    return false;
  }
}

/** Plugin endpoint’ine post bas */
async function pushToWp({ title, contentHtml, imageUrl, sourceUrl }) {
  const payload = {
    title,
    content: contentHtml,
    image: imageUrl || "",
    source: sourceUrl || ""
  };

  const r = await fetch(PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-bot-token": BOT_TOKEN
    },
    body: JSON.stringify(payload)
  });

  let j = null;
  try { j = await r.json(); } catch {}

  if (!r.ok) {
    console.log("WP PUSH HATA:", r.status, j || {});
    return null;
  }
  return j?.post_id || null;
}

/** Liste sayfasından detay linklerini çek (absolute + filtre) */
async function scrapeList(page, host) {
  const baseUrl = page.url();

  const items = await page.$$eval("a[href]", as =>
    as
      .map(a => ({
        href: a.getAttribute("href") || "",
        text: (a.textContent || "").replace(/\s+/g, " ").trim()
      }))
      .filter(x => x.href && x.text)
  );

  const out = [];
  const seen = new Set();

  for (const it of items) {
    let url = it.href;

    if (url.startsWith("/")) url = new URL(url, baseUrl).toString();
    if (!url.startsWith("http")) continue;

    try {
      const u = new URL(url);
      if (u.host !== host) continue;
      if (u.pathname === "/haberler" || u.pathname === "/haberler/") continue;

      const looksDetail =
        u.pathname.includes("merkezicerik") ||
        /\d{2}[-/.]\d{2}[-/.]\d{4}/.test(u.pathname) ||
        u.pathname.split("/").filter(Boolean).length >= 2;

      if (!looksDetail) continue;

      if (!seen.has(url)) {
        seen.add(url);
        out.push({ url, text: it.text });
      }
      if (out.length >= 20) break;
    } catch {
      continue;
    }
  }

  return out;
}

/** Detay sayfasından başlık + içerik + görsel */
async function scrapeDetail(page, srcName) {
  let title = "";

  // h1 kısa bekle
  try {
    const h1 = page.locator("h1").first();
    await h1.waitFor({ timeout: 5000 });
    title = clean(await h1.textContent());
  } catch {}

  // og:title
  if (!title) {
    try {
      const og = await page.locator('meta[property="og:title"]').first().getAttribute("content");
      title = clean(og);
    } catch {}
  }

  // <title>
  if (!title) {
    try { title = clean(await page.title()); } catch {}
  }

  // içerik
  let text = "";
  try {
    const candidates = ["main", "article", ".content", ".icerik", ".page-content", ".container"];
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        const t = clean(await loc.innerText().catch(() => ""));
        if (t && t.length > 200) { text = t; break; }
      }
    }
    if (!text) text = clean(await page.locator("body").innerText());
  } catch {
    text = "";
  }

  if (text.length > 6500) text = text.slice(0, 6500);

  // görsel
  let img = "";
  try {
    img = await page.locator("main img, article img, img").first().getAttribute("src");
    if (img && img.startsWith("/")) img = new URL(img, page.url()).toString();
    if (!img) img = "";
  } catch {
    img = "";
  }

  // paragrafla
  const parts = text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map(p => clean(p))
    .filter(p => p.length >= 40)
    .slice(0, 10);

  const pHtml = (parts.length ? parts : [text.slice(0, 900)])
    .filter(Boolean)
    .map(p => `<p>${esc(p)}</p>`)
    .join("");

  // kaynak linki ayrıca plugin’e de gidecek ama içerikte de dursun
  const html = `
${pHtml}
<p><small>Kaynak: <a href="${page.url()}" target="_blank" rel="nofollow noopener">${esc(srcName)}</a></small></p>
  `.trim();

  return { title, html, img };
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
    await page.goto(src.list, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const links = await scrapeList(page, src.host);
    console.log("Bulunan aday:", links.length);

    for (const it of links) {
      if (await wpAlreadyPosted(it.url)) continue;

      console.log("Detay:", it.url);
      await page.goto(it.url, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});

      const d = await scrapeDetail(page, src.name);
      const title = d.title || clean(it.text) || "Asayiş Haberi";

      const postId = await pushToWp({
        title,
        contentHtml: d.html,
        imageUrl: d.img,
        sourceUrl: it.url
      });

      if (postId) console.log("✅ WP’ye eklendi:", postId);
    }
  }

  await browser.close();
})();
