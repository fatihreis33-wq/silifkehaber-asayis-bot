import { chromium } from "@playwright/test";
import fetch from "node-fetch";

const WP_BASE = process.env.WP_BASE;
const WP_USER = process.env.WP_USER;
const WP_APP_PASS = process.env.WP_APP_PASS;
const ASAYIS_SLUG = process.env.ASAYIS_SLUG || "asayis";

if (!WP_BASE || !WP_USER || !WP_APP_PASS) {
  console.error("ENV eksik: WP_BASE, WP_USER, WP_APP_PASS");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString("base64");

const SOURCES = [
  { name: "Mersin Emniyet", list: "https://www.mersin.pol.tr/haberler", host: "www.mersin.pol.tr" },
  { name: "Mersin Jandarma", list: "https://mersin.jandarma.gov.tr/haberler", host: "mersin.jandarma.gov.tr" }
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

async function wpGetCategoryId() {
  const r = await fetch(`${WP_BASE}/wp-json/wp/v2/categories?slug=${encodeURIComponent(ASAYIS_SLUG)}`, {
    headers: { Authorization: auth }
  });
  const j = await r.json();
  if (Array.isArray(j) && j[0]?.id) return j[0].id;

  const c = await fetch(`${WP_BASE}/wp-json/wp/v2/categories`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Asayiş", slug: ASAYIS_SLUG })
  });
  const cj = await c.json();
  return cj?.id || null;
}

async function wpPostExists(url) {
  const r = await fetch(`${WP_BASE}/wp-json/wp/v2/posts?search=${encodeURIComponent(url)}&per_page=5`, {
    headers: { Authorization: auth }
  });
  const j = await r.json();
  return Array.isArray(j) && j.some(p => (p?.content?.rendered || "").includes(url));
}

async function wpUploadImage(url) {
  try {
    const img = await fetch(url);
    if (!img.ok) return null;
    const buf = Buffer.from(await img.arrayBuffer());
    const name = (url.split("/").pop() || "image.jpg").split("?")[0];

    const r = await fetch(`${WP_BASE}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Type": img.headers.get("content-type") || "image/jpeg"
      },
      body: buf
    });
    const j = await r.json();
    if (!r.ok) return null;
    return j?.id || null;
  } catch {
    return null;
  }
}

async function wpCreatePost({ title, html, mediaId, catId, excerpt }) {
  const r = await fetch(`${WP_BASE}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      content: html,
      excerpt: excerpt || "",
      status: "publish",
      categories: catId ? [catId] : [],
      ...(mediaId ? { featured_media: mediaId } : {})
    })
  });
  const j = await r.json();
  if (!r.ok) {
    console.log("WP post hata:", j);
    return null;
  }
  return j?.id || null;
}

/** Liste sayfasından gerçek detay linklerini yakala (daha sıkı filtre) */
async function scrapeList(page, host) {
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

    // absolute yap
    if (url.startsWith("/")) url = new URL(url, location.href).toString();
    if (!url.startsWith("http")) continue;

    try {
      const u = new URL(url);
      if (u.host !== host) continue;
      if (u.pathname === "/haberler" || u.pathname === "/haberler/") continue;

      // “detay” heuristikleri
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

/** Detay sayfasından başlık + içerik + görsel (h1 yoksa fallback) */
async function scrapeDetail(page, srcName) {
  // h1 bekleme: kısa tut, yoksa fallback
  let title = "";
  try {
    const h1 = page.locator("h1").first();
    await h1.waitFor({ timeout: 5000 });
    title = clean(await h1.textContent());
  } catch {}

  if (!title) {
    // og:title
    try {
      const og = await page.locator('meta[property="og:title"]').first().getAttribute("content");
      title = clean(og);
    } catch {}
  }

  if (!title) {
    // <title>
    try {
      title = clean(await page.title());
    } catch {}
  }

  // içerik
  let text = "";
  try {
    // olası ana alanlar
    const candidates = ["main", "article", ".content", ".icerik", ".page-content", ".container"];
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        const t = clean(await loc.innerText().catch(() => ""));
        if (t && t.length > 200) { text = t; break; }
      }
    }
    if (!text) text = clean(await page.locator("body").innerText());
  } catch {
    text = "";
  }

  if (text.length > 6000) text = text.slice(0, 6000);

  // görsel
  let img = null;
  try {
    img = await page.locator("main img, article img, img").first().getAttribute("src");
    if (img && img.startsWith("/")) img = new URL(img, page.url()).toString();
  } catch {}

  const excerpt = clean(text).slice(0, 180);

  // html paragrafla
  const parts = text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map(p => clean(p))
    .filter(p => p.length >= 40)
    .slice(0, 10);

  const pHtml = (parts.length ? parts : [text.slice(0, 800)])
    .filter(Boolean)
    .map(p => `<p>${esc(p)}</p>`)
    .join("");

  const html = `
${pHtml}
<p><small>Kaynak: <a href="${page.url()}" target="_blank" rel="nofollow noopener">${esc(srcName)}</a></small></p>
  `.trim();

  return { title, html, img, excerpt };
}

(async () => {
  const catId = await wpGetCategoryId();
  if (!catId) throw new Error("Asayiş kategorisi bulunamadı/oluşturulamadı.");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (compatible; SilifkeHaberBot/1.0)"
  });

  // Genel timeout’ları büyüt
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);

  for (const src of SOURCES) {
    console.log("Liste:", src.list);
    await page.goto(src.list, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    const links = await scrapeList(page, src.host);
    console.log("Bulunan aday:", links.length);

    for (const it of links) {
      if (await wpPostExists(it.url)) continue;

      console.log("Detay:", it.url);
      await page.goto(it.url, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});

      const d = await scrapeDetail(page, src.name);

      const title = d.title || clean(it.text) || "Asayiş Haberi";

      let mediaId = null;
      if (d.img && d.img.startsWith("http")) {
        mediaId = await wpUploadImage(d.img);
      }

      const postId = await wpCreatePost({
        title,
        html: d.html,
        mediaId,
        catId,
        excerpt: d.excerpt
      });

      if (postId) console.log("✅ Eklendi:", postId);
    }
  }

  await browser.close();
})();
