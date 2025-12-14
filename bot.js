// === SilifkeHaber Asayiş Bot (Playwright) ===
import { chromium } from "@playwright/test";
import fetch from "node-fetch";

const WP_BASE = process.env.WP_BASE;
const WP_USER = process.env.WP_USER;
const WP_APP_PASS = process.env.WP_APP_PASS;
const ASAYIS_SLUG = "asayis";

const auth = "Basic " + Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString("base64");

const SOURCES = [
  { name: "Mersin Emniyet", list: "https://www.mersin.pol.tr/haberler" },
  { name: "Mersin Jandarma", list: "https://mersin.jandarma.gov.tr/haberler" }
];

function clean(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

async function getCategoryId() {
  const r = await fetch(`${WP_BASE}/wp-json/wp/v2/categories?slug=${ASAYIS_SLUG}`, {
    headers: { Authorization: auth }
  });
  const j = await r.json();
  if (j[0]?.id) return j[0].id;

  const c = await fetch(`${WP_BASE}/wp-json/wp/v2/categories`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name: "Asayiş", slug: ASAYIS_SLUG })
  });
  const cj = await c.json();
  return cj.id;
}

async function exists(url) {
  const r = await fetch(`${WP_BASE}/wp-json/wp/v2/posts?search=${encodeURIComponent(url)}`, {
    headers: { Authorization: auth }
  });
  const j = await r.json();
  return Array.isArray(j) && j.some(p => p.content.rendered.includes(url));
}

async function uploadImage(url) {
  const img = await fetch(url);
  const buf = Buffer.from(await img.arrayBuffer());
  const name = url.split("/").pop();

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
  return j.id;
}

async function createPost(title, content, media, cat) {
  await fetch(`${WP_BASE}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title,
      content,
      status: "publish",
      categories: [cat],
      featured_media: media
    })
  });
}

(async () => {
  const catId = await getCategoryId();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  for (const src of SOURCES) {
    await page.goto(src.list, { waitUntil: "networkidle" });
    const links = await page.$$eval("a[href]", a =>
      a.map(x => x.href).filter(h => h.includes("haber"))
    );

    for (const link of links.slice(0, 5)) {
      if (await exists(link)) continue;

      await page.goto(link, { waitUntil: "networkidle" });
      const title = clean(await page.locator("h1").first().textContent());
      const text = clean(await page.locator("body").innerText());
      const img = await page.locator("img").first().getAttribute("src");

      const html = `<p>${text.slice(0, 4000)}</p>
      <p><a href="${link}" target="_blank">Kaynak: ${src.name}</a></p>`;

      let mediaId = null;
      if (img?.startsWith("http")) mediaId = await uploadImage(img);

      await createPost(title, html, mediaId, catId);
    }
  }

  await browser.close();
})();
