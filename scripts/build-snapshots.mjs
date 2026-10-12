#!/usr/bin/env node
// Builds plain-HTML copies of every post under posts/ so tools that don't run
// JavaScript (ChatGPT's browser, link previews, screen readers) can read them.
//
//   posts/index.html               months + the coming week
//   posts/2026-10.html             every post in the month, full text
//   posts/2026-10-13-brand.html    one post (…-doreen.html for Doreen)
//
// Data comes from the same n8n webhook the Social Review page uses.
// Files are only rewritten when their content changes, so a run with no
// changes produces no commit.
//
// Usage: node scripts/build-snapshots.mjs [YYYY-MM ...]
//   With no arguments it refreshes the current and next month (plus last
//   month during the first few days of a new month), in Central time.

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const WEBHOOK = process.env.SS_POSTS_WEBHOOK || 'https://memorex.app.n8n.cloud/webhook/ss-posts';
const OUT_DIR = path.resolve(process.env.SS_OUT_DIR || 'posts');
const SITE_URL = (process.env.SS_SITE_URL || 'https://prouhet.github.io/ss-socials/').replace(/\/?$/, '/');
const TZ = 'America/Chicago';
const PREV_MONTH_GRACE_DAYS = 3;   // keep refreshing last month this many days into a new one
const STAMP = '__SNAPSHOT_STAMP__';

// ── Dates (all in Central time) ──────────────────────────────────────────────
function centralParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date).map(p => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day };
}
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
function addMonths(y, m, n) {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}
function defaultMonths() {
  const { y, m, d } = centralParts();
  const months = [ym(y, m)];
  const next = addMonths(y, m, 1);
  months.push(ym(next.y, next.m));
  if (d <= PREV_MONTH_GRACE_DAYS) {
    const prev = addMonths(y, m, -1);
    months.unshift(ym(prev.y, prev.m));
  }
  return months;
}
const todayIso = () => { const { y, m, d } = centralParts(); return `${ym(y, m)}-${String(d).padStart(2, '0')}`; };

function dateFromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
const fmtLong = iso => dateFromIso(iso).toLocaleDateString('en-US',
  { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const fmtShort = iso => dateFromIso(iso).toLocaleDateString('en-US',
  { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const monthName = key => dateFromIso(`${key}-01`).toLocaleDateString('en-US',
  { timeZone: 'UTC', month: 'long', year: 'numeric' });
const stampNow = () => new Date().toLocaleString('en-US', {
  timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

// ── Post helpers (slug logic must match postSlug() in index.html) ────────────
const voiceKey = p => (p.voice === 'brand' ? 'brand' : 'doreen');
const VOICE_LABEL = { brand: 'Brand', doreen: 'Doreen' };
const VOICE_LONG = { brand: 'Brand (Studio Strong page voice)', doreen: 'Doreen (first-person trainer voice)' };
const RATING_LABEL = { 'loved-it': '💚 Loved it', ok: '🆗 OK', 'brief-missed': '💩 Brief missed' };
const isIsoDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function assignSlugs(posts) {
  const groups = new Map();
  for (const p of posts) {
    const key = `${p.postDate}-${voiceKey(p)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [key, group] of groups) {
    group.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    group.forEach((p, i) => { p._slug = i === 0 ? key : `${key}-${i + 1}`; });
  }
}
const sortPosts = posts => [...posts].sort((a, b) =>
  a.postDate.localeCompare(b.postDate) || (voiceKey(a) === 'brand' ? -1 : 1) - (voiceKey(b) === 'brand' ? -1 : 1)
  || a._slug.localeCompare(b._slug));
const finalCaption = p => (p.selectedCaption || p.captionA || '').trim();
const statusText = s => { const t = String(s || 'no status').replace(/_/g, ' '); return t[0].toUpperCase() + t.slice(1); };

// ── HTML helpers ─────────────────────────────────────────────────────────────
const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : '');
function driveThumb(url) {
  if (!url.includes('drive.google.com')) return url;
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w500` : url;
}
// Blank-line-separated blocks become paragraphs; single newlines become <br>.
function textBlock(text) {
  return String(text || '').trim().split(/\n\s*\n/).filter(Boolean)
    .map(block => `<p>${block.split('\n').map(esc).join('<br>\n')}</p>`).join('\n');
}

const CSS = `
:root{--navy:#0f1d35;--navy2:#1a2f52;--orange:#f05a28;--muted:#5d6b85;--border:#dde3ee;--cream:#fafaf7;
--brand:#1a5cad;--doreen:#c2185b;--approved:#1a8a4a;--review:#b07208}
*{box-sizing:border-box}
body{margin:0;background:var(--cream);color:var(--navy);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 56px}
a{color:var(--brand)} a:hover{color:var(--orange)}
nav.crumbs{font-size:14px;color:var(--muted);margin-bottom:18px}
h1{font-size:26px;line-height:1.25;margin:4px 0 14px}
h2{font-size:15px;letter-spacing:1.2px;text-transform:uppercase;color:var(--navy2);margin:28px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px}
h3{font-size:18px;margin:0 0 6px}
.kicker{font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0}
.kicker.brand{color:var(--brand)} .kicker.doreen{color:var(--doreen)}
dl.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0;font-size:15px}
dl.facts dt{color:var(--muted);font-weight:600} dl.facts dd{margin:0}
.caption{background:#fff;border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.caption p{margin:0 0 12px} .caption p:last-child{margin:0}
.meta{font-size:13px;color:var(--muted)}
.status-approved{color:var(--approved);font-weight:700} .status-ready_for_review{color:var(--review);font-weight:700}
.images{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
figure{margin:0;background:#fff;border:1px solid var(--border);border-radius:10px;overflow:hidden}
figure.selected{border:2px solid var(--approved)}
figure img{display:block;width:100%;aspect-ratio:1;object-fit:cover;background:#eef1f6}
figcaption{padding:8px 10px;font-size:13px}
.pager{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-top:32px;font-size:14px}
.day{border-top:1px solid var(--border);padding:14px 0}
.day-list{list-style:none;padding:0;margin:0}
.day-list li{padding:8px 0;border-bottom:1px solid var(--border)}
.tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;border-radius:4px;padding:1px 6px;color:#fff;margin-right:6px}
.tag.brand{background:var(--brand)} .tag.doreen{background:var(--doreen)}
section.post{background:#fff;border:1px solid var(--border);border-radius:12px;padding:16px;margin:16px 0}
section.post .caption{border:0;padding:0}
table.month{width:100%;border-collapse:collapse;font-size:15px;table-layout:fixed}
table.month th,table.month td{vertical-align:top;text-align:left;padding:10px 8px;border-bottom:1px solid var(--border)}
table.month thead th{font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);border-bottom:2px solid var(--border)}
table.month thead th:first-child{width:112px}
table.month tbody th{font-size:14px}
table.month tr.new-week>*{border-top:2px solid #c3cddd}
table.month tr.past{color:#56637a}
table.month tr.today{background:#fff3ec}
table.month tr.today th{color:var(--orange)}
.entry+.entry{margin-top:10px}
.hook{font-size:13px;color:var(--muted);margin-top:2px}
.today-tag{display:inline-block;font-size:10px;font-weight:800;letter-spacing:1px;background:var(--orange);color:#fff;border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle}
@media (max-width:600px){table.month thead{display:none}
table.month tr{display:block;padding:8px 0;border-bottom:1px solid var(--border)}
table.month tr.new-week{border-top:2px solid #c3cddd}
table.month tr.new-week>*{border-top:0}
table.month th,table.month td{display:block;border:0;padding:4px 4px;width:auto}}
footer{margin-top:40px;font-size:13px;color:var(--muted);border-top:1px solid var(--border);padding-top:12px}
@media (max-width:520px){dl.facts{grid-template-columns:1fr} dl.facts dt{margin-top:6px}}
`;

function page({ title, description, body, extraMeta = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<meta name="ss-hash" content="__HASH__">
${extraMeta}<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<style>${CSS}</style>
</head>
<body>
<main>
${body}
<footer>
Text-only snapshot of the Studio Strong Content Queue, taken ${STAMP}. It refreshes once a day, early in the morning (Central time).
Review, edit and approve posts on the <a href="../">Social Review page</a>.
</footer>
</main>
</body>
</html>
`;
}

function factsList(p) {
  const rows = [
    ['Date', fmtLong(p.postDate)],
    ['Voice', VOICE_LONG[voiceKey(p)]],
    ['Status', `<span class="status-${esc(p.status)}">${esc(statusText(p.status))}</span>`, true],
    ['Suggested time', p.suggestedTime],
    ['Post type', p.postType],
    ['Audience', p.audience],
    ['Platforms', p.platforms],
    ['Image route', p.imageRoute],
  ].filter(([, v]) => v);
  return `<dl class="facts">\n${rows.map(([k, v, raw]) =>
    `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join('\n')}\n</dl>`;
}

function imagesBlock(p) {
  const slots = [['A', 'imageUrlA', 'feedbackTagA'], ['B', 'imageUrlB', 'feedbackTagB'], ['C', 'imageUrlC', 'feedbackTagC']];
  const figs = slots.map(([letter, key, tagKey]) => {
    const url = safeUrl(p[key]);
    if (!url) return '';
    const selected = url === safeUrl(p.selectedImageUrl);
    const notes = [selected ? '<strong>✓ Selected</strong>' : '', RATING_LABEL[p[tagKey]] || ''].filter(Boolean).join(' · ');
    return `<figure${selected ? ' class="selected"' : ''}>
<a href="${esc(url)}"><img src="${esc(driveThumb(url))}" alt="Image option ${letter} for: ${esc(p.theme || 'this post')}" loading="lazy"></a>
<figcaption>Image ${letter}${notes ? ` — ${notes}` : ''} · <a href="${esc(url)}">open full size</a></figcaption>
</figure>`;
  }).filter(Boolean);
  if (!figs.length) return '<p class="meta">No images generated yet.</p>';
  const other = safeUrl(p.selectedImageUrl) && !slots.some(([, k]) => safeUrl(p[k]) === safeUrl(p.selectedImageUrl))
    ? `<p>Selected image (not one of A–C): <a href="${esc(safeUrl(p.selectedImageUrl))}">open</a></p>` : '';
  return `<div class="images">\n${figs.join('\n')}\n</div>${other}`;
}

function postBody(p, { headingLevel = 1, includeImages = true } = {}) {
  const v = voiceKey(p);
  const h = `h${headingLevel}`;
  const caption = finalCaption(p);
  const sub = `h${headingLevel + 1}`;
  const parts = [
    `<p class="kicker ${v}">${VOICE_LABEL[v]} post · ${esc(fmtLong(p.postDate))}</p>`,
    `<${h}>${esc(p.theme || '(no theme)')}</${h}>`,
    factsList(p),
    `<${sub}>Caption${p.selectedCaption ? ' (approved)' : ' (draft)'}</${sub}>`,
    caption ? `<div class="caption">\n${textBlock(caption)}\n</div>\n<p class="meta">${caption.length} characters</p>`
            : '<p class="meta">No caption yet.</p>',
  ];
  if (p.selectedCaption && p.captionA && p.selectedCaption.trim() !== p.captionA.trim()) {
    parts.push(`<${sub}>Original draft caption</${sub}>`, `<div class="caption">\n${textBlock(p.captionA)}\n</div>`);
  }
  if (p.hashtags) parts.push(`<${sub}>Hashtags</${sub}>`, `<p>${esc(p.hashtags)}</p>`);
  if (includeImages) parts.push(`<${sub}>Image options</${sub}>`, imagesBlock(p));
  if (p.imageBrief) parts.push(`<${sub}>Image brief</${sub}>`, textBlock(p.imageBrief));
  if (p.notes) parts.push(`<${sub}>Planning notes</${sub}>`, textBlock(p.notes));
  const feedback = [p.feedbackTag === 'used-manus' ? 'Used a Manus image instead.' : '', p.imageFeedback || '']
    .filter(Boolean).join('\n\n');
  if (feedback) parts.push(`<${sub}>Image notes from review</${sub}>`, textBlock(feedback));
  return parts.join('\n');
}

// ── Page builders ────────────────────────────────────────────────────────────
function postPage(p, monthKey, ordered) {
  const i = ordered.indexOf(p);
  const sameDay = ordered.filter(q => q !== p && q.postDate === p.postDate);
  const prev = ordered.slice(0, i).reverse().find(q => q.postDate !== p.postDate && voiceKey(q) === voiceKey(p));
  const next = ordered.slice(i + 1).find(q => q.postDate !== p.postDate && voiceKey(q) === voiceKey(p));
  const link = q => `<a href="${q._slug}.html">${VOICE_LABEL[voiceKey(q)]} · ${esc(fmtShort(q.postDate))}</a>`;
  const body = `<nav class="crumbs"><a href="index.html">All months</a> › <a href="${monthKey}.html">${esc(monthName(monthKey))}</a> › ${esc(fmtShort(p.postDate))} ${VOICE_LABEL[voiceKey(p)]}</nav>
<article>
${postBody(p)}
</article>
<div class="pager">
<span>${prev ? `← ${link(prev)}` : ''}</span>
<span>${sameDay.length ? `Same day: ${sameDay.map(link).join(', ')}` : ''}</span>
<span>${next ? `${link(next)} →` : ''}</span>
</div>`;
  const title = `${VOICE_LABEL[voiceKey(p)]} post, ${fmtShort(p.postDate)}: ${p.theme || '(no theme)'} — Studio Strong`;
  const description = `${VOICE_LABEL[voiceKey(p)]} social post for ${fmtLong(p.postDate)} — caption, image options, brief and notes.`;
  return page({ title, description, body });
}

function monthPage(monthKey, ordered) {
  const byDay = new Map();
  for (const p of ordered) {
    if (!byDay.has(p.postDate)) byDay.set(p.postDate, []);
    byDay.get(p.postDate).push(p);
  }
  const toc = [...byDay].map(([day, posts]) =>
    `<li><strong>${esc(fmtShort(day))}</strong> — ${posts.map(p =>
      `<span class="tag ${voiceKey(p)}">${VOICE_LABEL[voiceKey(p)]}</span><a href="${p._slug}.html">${esc(p.theme || '(no theme)')}</a> <span class="meta">(${esc(statusText(p.status))}${p.suggestedTime ? `, ${esc(p.suggestedTime)}` : ''})</span>`
    ).join('<br>')}</li>`).join('\n');
  const full = ordered.map(p => `<section class="post" id="${p._slug}">
${postBody(p, { headingLevel: 3, includeImages: false })}
<p class="meta"><a href="${p._slug}.html">Open this post on its own page (with images)</a></p>
</section>`).join('\n');
  const name = monthName(monthKey);
  const body = `<nav class="crumbs"><a href="index.html">All months</a> › ${esc(name)}</nav>
<h1>${esc(name)} — all social posts</h1>
<p>Every Brand and Doreen post planned for ${esc(name)}, with full captions, image briefs and planning notes.
Each post also has its own page named by date and voice, for example <code>${esc(ordered[0]._slug)}.html</code>.</p>
<h2>Day by day</h2>
<ul class="day-list">
${toc}
</ul>
<h2>Full posts</h2>
${full}`;
  return page({
    title: `${name} social posts — Studio Strong`,
    description: `All ${ordered.length} Studio Strong social posts for ${name}: captions, image briefs and notes.`,
    body,
    extraMeta: `<meta name="ss-count" content="${ordered.length}">\n`,
  });
}

const captionHook = p => finalCaption(p).split('\n').map(l => l.trim()).find(Boolean) || '';

// Every calendar day of the month, Brand and Doreen side by side, today highlighted.
function monthTable(monthKey, posts, today) {
  const [y, m] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const byDay = new Map();
  for (const p of sortPosts(posts)) {
    if (!byDay.has(p.postDate)) byDay.set(p.postDate, { brand: [], doreen: [] });
    byDay.get(p.postDate)[voiceKey(p)].push(p);
  }
  const cell = (list, voice) => list.length
    ? list.map(p => `<div class="entry"><span class="tag ${voice}">${VOICE_LABEL[voice]}</span><a href="${p._slug}.html">${esc(p.theme || '(no theme)')}</a>
<div class="meta">${esc(statusText(p.status))}${p.suggestedTime ? ` · ${esc(p.suggestedTime)}` : ''}</div>${captionHook(p) ? `\n<div class="hook">${esc(captionHook(p))}</div>` : ''}</div>`).join('\n')
    : `<span class="meta">No ${VOICE_LABEL[voice]} post</span>`;
  const rows = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${monthKey}-${String(d).padStart(2, '0')}`;
    const day = byDay.get(iso) || { brand: [], doreen: [] };
    const cls = [iso === today ? 'today' : iso < today ? 'past' : '',
      d > 1 && dateFromIso(iso).getUTCDay() === 0 ? 'new-week' : ''].filter(Boolean).join(' ');
    rows.push(`<tr${cls ? ` class="${cls}"` : ''}>
<th scope="row">${esc(fmtShort(iso))}${iso === today ? '<span class="today-tag">TODAY</span>' : ''}</th>
<td>${cell(day.brand, 'brand')}</td>
<td>${cell(day.doreen, 'doreen')}</td>
</tr>`);
  }
  return `<table class="month">
<thead><tr><th scope="col">Day</th><th scope="col">Brand</th><th scope="col">Doreen</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>`;
}

function indexPage(monthEntries, monthKey, posts, today) {
  const months = monthEntries.map(({ key, count }) =>
    `<li><a href="${key}.html">${esc(monthName(key))}</a> <span class="meta">— ${count} posts</span></li>`).join('\n');
  const name = monthName(monthKey);
  const calendar = posts.length
    ? `<p>Every day of ${esc(name)}, past and upcoming. Tap a post for its full caption, image options, brief and notes,
or open <a href="${monthKey}.html">all ${esc(name)} posts in full on one page</a>.</p>
${monthTable(monthKey, posts, today)}`
    : `<p class="meta">No posts in ${esc(name)} yet.</p>`;
  const body = `<h1>Studio Strong social posts — text copies</h1>
<p>Plain-text copies of every post in the Studio Strong Content Queue, so ChatGPT and other AI tools can read them without running the review app.
Each post has its own page named by date and voice: <code>${esc(SITE_URL)}posts/YYYY-MM-DD-brand.html</code> for the Brand post and <code>${esc(SITE_URL)}posts/YYYY-MM-DD-doreen.html</code> for Doreen's post.
Each month page has every post for that month in full.</p>
<h2>${esc(name)}</h2>
${calendar}
<h2>All months</h2>
<ul>
${months}
</ul>`;
  return page({
    title: 'Studio Strong social posts — text copies',
    description: `Every Studio Strong Brand and Doreen social post for ${name}, day by day, plus links to every month.`,
    body,
  });
}

// ── File writing (skip unchanged) ────────────────────────────────────────────
let written = 0, unchanged = 0, removed = 0;
async function writeIfChanged(file, html) {
  const hash = createHash('sha256').update(html).digest('hex').slice(0, 16);
  const full = path.join(OUT_DIR, file);
  try {
    const existing = await readFile(full, 'utf8');
    if (existing.includes(`<meta name="ss-hash" content="${hash}">`)) { unchanged++; return; }
  } catch { /* new file */ }
  await writeFile(full, html.replace('__HASH__', hash).replace(STAMP, esc(stampNow())));
  written++;
}

async function fetchMonth(monthKey) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${WEBHOOK}?month=${monthKey}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trim()) throw new Error('empty body (is the n8n workflow active?)');
      const data = JSON.parse(text);
      const posts = Array.isArray(data) ? data : (data.posts || []);
      return posts.filter(p => p && p.id != null && isIsoDate(p.postDate) && p.postDate.startsWith(monthKey));
    } catch (e) {
      lastErr = e;
      if (attempt === 1) await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const months = process.argv.slice(2).filter(a => /^\d{4}-\d{2}$/.test(a));
const currentMonth = todayIso().slice(0, 7);
const targetMonths = months.length ? months : defaultMonths();
if (!targetMonths.includes(currentMonth)) targetMonths.push(currentMonth);   // the index always shows this month
await mkdir(OUT_DIR, { recursive: true });

const results = new Map();   // every month that loaded, even if empty
const fetched = new Map();   // months that have posts
let failures = 0;
for (const key of targetMonths) {
  try {
    const posts = await fetchMonth(key);
    console.log(`${key}: ${posts.length} posts`);
    results.set(key, posts);
    if (posts.length) fetched.set(key, posts);
  } catch (e) {
    failures++;
    console.warn(`::warning::${key}: could not load posts — ${e.message}. Leaving existing pages as they are.`);
  }
}
if (failures === targetMonths.length) {
  console.error('::error::Every month failed to load; nothing updated.');
  process.exit(1);
}

const existingFiles = await readdir(OUT_DIR);
for (const [key, posts] of fetched) {
  assignSlugs(posts);
  const ordered = sortPosts(posts);
  const keep = new Set(ordered.map(p => `${p._slug}.html`));
  for (const p of ordered) await writeIfChanged(`${p._slug}.html`, postPage(p, key, ordered));
  await writeIfChanged(`${key}.html`, monthPage(key, ordered));
  // Remove pages for posts that no longer exist in this month
  const stale = existingFiles.filter(f => f.startsWith(`${key}-`) && /^\d{4}-\d{2}-\d{2}-(brand|doreen)(-\d+)?\.html$/.test(f) && !keep.has(f));
  for (const f of stale) { await unlink(path.join(OUT_DIR, f)); removed++; }
}

// Index: this month day by day, plus every month page on disk (newest first)
const monthFiles = (await readdir(OUT_DIR)).filter(f => /^\d{4}-\d{2}\.html$/.test(f)).sort().reverse();
const monthEntries = [];
for (const f of monthFiles) {
  const html = await readFile(path.join(OUT_DIR, f), 'utf8');
  const count = +(html.match(/<meta name="ss-count" content="(\d+)">/)?.[1] || 0);
  monthEntries.push({ key: f.replace('.html', ''), count });
}
if (results.has(currentMonth)) {
  await writeIfChanged('index.html', indexPage(monthEntries, currentMonth, results.get(currentMonth), todayIso()));
} else {
  console.warn(`::warning::${currentMonth} didn't load, so posts/index.html was left as it was.`);
}

console.log(`Done: ${written} written, ${unchanged} unchanged, ${removed} removed.`);
