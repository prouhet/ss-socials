// Review tools for the text-only post pages (posts/YYYY-MM-DD-voice.html).
//
// The page itself is plain HTML so ChatGPT can read it. In a browser, this
// script loads the post's live data from n8n and adds the same controls as the
// Social Review panel: vote on each image, pick one, edit the caption, add image
// notes, and approve or save changes through the ss-approve webhook.
//
// Unsaved edits are kept on this device (localStorage) until they're saved, so
// closing the tab or bouncing over to ChatGPT doesn't lose a draft.
//
// Hand-maintained (not generated). scripts/build-snapshots.mjs adds a ?v= hash
// of this file to every post page, so edits here reach browsers on the next
// refresh of the pages.
(() => {
  'use strict';

  const CONFIG = {
    GET_POSTS_WEBHOOK: 'https://memorex.app.n8n.cloud/webhook/ss-posts',
    APPROVE_WEBHOOK:   'https://memorex.app.n8n.cloud/webhook/ss-approve',
    // Shows a "Save draft" button that saves without approving. Only turn this
    // on once ss-approve sets Status from the request's `status` field; if it
    // always writes "approved", Save draft would approve the post.
    SAVE_DRAFT_TO_NOTION: false,
  };

  const article = document.querySelector('article[data-post-id]');
  if (!article) return;
  const POST_ID = article.dataset.postId;
  const MONTH = article.dataset.month;
  const DRAFT_KEY = `ss-socials:draft:${POST_ID}`;

  const RATINGS = [
    { val: 'loved-it',     icon: '💚', label: 'Loved it' },
    { val: 'ok',           icon: '🆗', label: 'OK' },
    { val: 'brief-missed', icon: '💩', label: 'Brief missed' },
  ];
  const SLOTS = { A: 'feedbackTagA', B: 'feedbackTagB', C: 'feedbackTagC' };
  const URL_KEYS = { A: 'imageUrlA', B: 'imageUrlB', C: 'imageUrlC' };

  const q = (sel, root = article) => root.querySelector(sel);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(c => c != null && n.append(c));
    return n;
  };
  const statusText = s => { const t = String(s || 'no status').replace(/_/g, ' '); return t[0].toUpperCase() + t.slice(1); };
  const fmtTime = ts => new Date(ts).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const store = {
    get() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } },
    set(v) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(v)); } catch { /* storage off */ } },
    clear() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage off */ } },
  };

  injectStyles();
  const toast = el('div', { class: 'rv-toast', role: 'status', 'aria-live': 'polite' });
  document.body.append(toast);
  const loadingNote = el('p', { class: 'rv-note' }, 'Loading review tools…');
  article.prepend(loadingNote);

  let post = null;       // live record from n8n
  let loaded = null;     // values as last loaded/saved (for "unsaved changes")
  let cur = null;        // values on screen now
  let votesStored = false;
  let saving = false;
  const ui = {};

  init().catch(err => {
    console.error(err);
    loadingNote.className = 'rv-note rv-warn';
    loadingNote.textContent = `Couldn't load the live post, so voting and editing are off right now (${err.message}). The text below is from the last daily snapshot.`;
  });

  async function init() {
    const res = await fetch(`${CONFIG.GET_POSTS_WEBHOOK}?month=${encodeURIComponent(MONTH)}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim()) throw new Error('empty reply from n8n');
    const data = JSON.parse(text);
    const posts = Array.isArray(data) ? data : (data.posts || []);
    post = posts.find(p => String(p.id) === POST_ID);
    if (!post) throw new Error('post not found in the Content Queue');
    votesStored = Object.values(SLOTS).every(k => k in post);

    loaded = valuesFrom(post);
    cur = { ...loaded };

    const draft = store.get();
    let restored = null;
    if (draft && draft.edits && !same(draft.edits, loaded)) {
      cur = { ...loaded, ...draft.edits };
      restored = draft;
    }

    loadingNote.remove();
    buildCaption();
    buildImages();
    buildNotes();
    buildBar();
    if (restored) showRestoreBanner(restored);
    renderAll();
  }

  function valuesFrom(p) {
    return {
      caption: (p.selectedCaption || p.captionA || '').trim(),
      image:   p.selectedImageUrl || '',
      tagA:    p.feedbackTagA || '',
      tagB:    p.feedbackTagB || '',
      tagC:    p.feedbackTagC || '',
      manus:   p.feedbackTag === 'used-manus' ? 'yes' : '',
      notes:   (p.imageFeedback || '').trim(),
    };
  }
  const same = (a, b) => Object.keys(b).every(k => (a[k] || '') === (b[k] || ''));
  const dirty = () => !same(cur, loaded);

  function changed() {
    if (dirty()) store.set({ savedAt: Date.now(), base: loaded, edits: cur });
    else store.clear();
    renderAll();
  }

  // ── Caption ────────────────────────────────────────────────────────────────
  function buildCaption() {
    const staticCap = q('[data-field="caption"]');
    const count = q('[data-field="caption-count"]');
    ui.caption = el('textarea', {
      class: 'rv-caption', 'aria-label': 'Caption', rows: '8',
      oninput: () => { cur.caption = ui.caption.value.trim(); grow(); changed(); },
    });
    ui.caption.value = cur.caption;
    ui.count = el('span', { class: 'rv-count' });
    const tools = el('div', { class: 'rv-row' },
      el('button', { type: 'button', class: 'rv-btn-ghost', onclick: () => copy(ui.caption.value, 'Caption copied') }, '📋 Copy caption'),
      el('button', { type: 'button', class: 'rv-btn-ghost', onclick: () => copy(location.href.split('#')[0], 'Link copied. Paste it into ChatGPT.') }, '🔗 Copy link for ChatGPT'),
      ui.count);
    const wrap = el('div', { class: 'rv-caption-wrap' }, ui.caption, tools);
    staticCap.replaceWith(wrap);
    if (count) count.remove();
    requestAnimationFrame(grow);
  }
  function grow() {
    ui.caption.style.height = 'auto';
    ui.caption.style.height = `${Math.max(160, ui.caption.scrollHeight + 4)}px`;
  }

  // ── Images ─────────────────────────────────────────────────────────────────
  function buildImages() {
    const grid = q('[data-field="images"]');
    if (!grid) return;
    const key = el('p', { class: 'rv-key' },
      RATINGS.map(r => el('span', {}, `${r.icon} ${r.label}`)),
      votesStored ? null : el('span', { class: 'rv-key-warn' }, 'Votes are sent when you approve, but Notion can’t store them yet.'));
    grid.before(key);
    ui.figures = {};
    grid.querySelectorAll('figure[data-slot]').forEach(fig => {
      const slot = fig.dataset.slot;
      const url = post[URL_KEYS[slot]] || fig.dataset.url;
      const rate = el('div', { class: 'rv-rate', role: 'group', 'aria-label': `Rate image ${slot}` },
        RATINGS.map(r => el('button', {
          type: 'button', class: 'rv-rate-btn', 'data-val': r.val, title: r.label, 'aria-label': `${r.label} (image ${slot})`,
          onclick: () => { const k = 'tag' + slot; cur[k] = cur[k] === r.val ? '' : r.val; changed(); },
        }, el('span', { 'aria-hidden': 'true' }, r.icon))));
      const pick = el('button', {
        type: 'button', class: 'rv-pick',
        onclick: () => { cur.image = cur.image === url ? '' : url; changed(); },
      });
      const cap = fig.querySelector('figcaption');
      cap.replaceChildren(`Image ${slot} · `, el('a', { href: url, target: '_blank', rel: 'noopener' }, 'full size ↗'));
      fig.append(el('div', { class: 'rv-fig-tools' }, pick, rate));
      ui.figures[slot] = { fig, pick, rate, url };
    });
  }

  // ── Image notes ────────────────────────────────────────────────────────────
  function buildNotes() {
    const old = q('[data-field="image-notes-static"]');
    ui.manus = el('input', { type: 'checkbox', onchange: () => { cur.manus = ui.manus.checked ? 'yes' : ''; changed(); } });
    ui.notes = el('textarea', {
      class: 'rv-notes', rows: '3', 'aria-label': 'Image notes',
      placeholder: 'Any notes for next month’s image generation…',
      oninput: () => { cur.notes = ui.notes.value.trim(); changed(); },
    });
    const section = el('section', { class: 'rv-notes-wrap' },
      el('h2', {}, 'Image notes ', el('span', { class: 'rv-opt' }, '(optional)')),
      el('label', { class: 'rv-check' }, ui.manus, ' 🖼 Used a Manus image instead'),
      ui.notes);
    const grid = q('[data-field="images"]');
    if (old) old.replaceWith(section);
    else if (grid) (grid.nextElementSibling?.tagName === 'P' ? grid.nextElementSibling : grid).after(section);
    else article.append(section);
  }

  // ── Save bar ───────────────────────────────────────────────────────────────
  function buildBar() {
    ui.barStatus = el('div', { class: 'rv-bar-status' });
    ui.discard = el('button', { type: 'button', class: 'rv-btn-ghost', onclick: discard }, 'Undo changes');
    ui.draftBtn = CONFIG.SAVE_DRAFT_TO_NOTION
      ? el('button', { type: 'button', class: 'rv-btn-secondary', onclick: () => save(false) }, 'Save draft') : null;
    ui.approveBtn = el('button', { type: 'button', class: 'rv-btn-primary', onclick: () => save(true) });
    const bar = el('div', { class: 'rv-bar' },
      ui.barStatus,
      el('div', { class: 'rv-bar-actions' }, ui.discard, ui.draftBtn, ui.approveBtn));
    document.body.append(bar);
    document.body.classList.add('rv-has-bar');
  }

  function showRestoreBanner(draft) {
    const baseChanged = draft.base && !same(draft.base, loaded);
    const banner = el('div', { class: 'rv-banner', role: 'status' },
      el('span', {}, `Picked up your unsaved changes from ${fmtTime(draft.savedAt)}.`,
        baseChanged ? ' This post was also changed somewhere else since then, so check it before saving.' : ''),
      el('button', { type: 'button', class: 'rv-btn-ghost', onclick: () => { discard(); banner.remove(); } }, 'Discard them'));
    article.prepend(banner);
    ui.banner = banner;
  }

  function discard() {
    cur = { ...loaded };
    ui.caption.value = cur.caption; grow();
    store.clear();
    ui.banner?.remove();
    renderAll();
  }

  // ── Render state ───────────────────────────────────────────────────────────
  function renderAll() {
    const approved = post.status === 'approved';
    ui.count.textContent = `${ui.caption.value.length} characters`;
    ui.count.classList.toggle('rv-over', ui.caption.value.length > 2200);
    ui.manus.checked = cur.manus === 'yes';
    if (document.activeElement !== ui.notes) ui.notes.value = cur.notes;

    for (const [slot, f] of Object.entries(ui.figures || {})) {
      const on = cur.image === f.url;
      f.fig.classList.toggle('selected', on);
      f.pick.textContent = on ? '✓ Selected' : 'Select';
      f.pick.classList.toggle('on', on);
      f.pick.setAttribute('aria-pressed', on ? 'true' : 'false');
      f.rate.querySelectorAll('.rv-rate-btn').forEach(b => {
        const pressed = cur['tag' + slot] === b.dataset.val;
        b.classList.toggle('on', pressed);
        b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      });
    }

    const statusEl = q('[data-field="status"]');
    if (statusEl) { statusEl.textContent = statusText(post.status); statusEl.className = `status-${post.status}`; }
    const heading = q('[data-field="caption-heading"]');
    if (heading) heading.textContent = `Caption ${approved ? '(approved)' : '(draft)'}`;

    const isDirty = dirty();
    ui.barStatus.replaceChildren(
      el('span', { class: `rv-dot status-${post.status}` }, statusText(post.status)),
      isDirty ? el('span', { class: 'rv-unsaved' }, ' · unsaved, kept on this device') : '');
    ui.discard.hidden = !isDirty;
    ui.approveBtn.textContent = saving ? 'Saving…' : approved ? 'Save changes' : 'Approve post ✓';
    ui.approveBtn.disabled = saving || (approved && !isDirty);
    if (ui.draftBtn) { ui.draftBtn.hidden = approved; ui.draftBtn.disabled = saving || !isDirty; }
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function save(approve) {
    if (saving) return;
    const caption = ui.caption.value.trim();
    if (!caption) { flash('⚠️ Add a caption first', true); ui.caption.focus(); return; }
    const wasApproved = post.status === 'approved';
    const status = approve || wasApproved ? 'approved' : post.status;
    const payload = {
      pageId:           POST_ID,
      selectedCaption:  caption,
      selectedImageUrl: cur.image || '',
      feedbackTag:      cur.manus === 'yes' ? 'used-manus'
                        : (post.feedbackTag === 'used-manus' ? '' : (post.feedbackTag || '')),
      feedbackTagA:     cur.tagA || '',
      feedbackTagB:     cur.tagB || '',
      feedbackTagC:     cur.tagC || '',
      imageFeedback:    cur.notes || '',
      status,
    };
    saving = true; renderAll();
    try {
      const res = await fetch(CONFIG.APPROVE_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${t ? ' — ' + t.slice(0, 120) : ''}`);
      }
      const result = await res.json().catch(() => ({}));
      if (result.ok === false) throw new Error(result.error || 'n8n said no');

      Object.assign(post, {
        status, selectedCaption: caption, selectedImageUrl: payload.selectedImageUrl,
        feedbackTag: payload.feedbackTag, imageFeedback: payload.imageFeedback,
        feedbackTagA: payload.feedbackTagA, feedbackTagB: payload.feedbackTagB, feedbackTagC: payload.feedbackTagC,
      });
      cur.caption = caption;
      loaded = { ...cur };
      store.clear();
      ui.banner?.remove();
      flash(approve && !wasApproved ? '✅ Approved! ChatGPT’s copy updates tomorrow morning.'
        : status === 'approved' ? '✅ Changes saved. ChatGPT’s copy updates tomorrow morning.'
        : '✅ Draft saved. ChatGPT’s copy updates tomorrow morning.');
    } catch (e) {
      console.error(e);
      flash(`❌ Didn't save: ${e.message}. Your changes are still kept on this device.`, true, 6000);
    }
    saving = false; renderAll();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); flash(msg); }
    catch { window.prompt('Copy this:', text); }
  }
  let toastTimer;
  function flash(msg, isError = false, ms = 3500) {
    toast.textContent = msg;
    toast.className = `rv-toast show${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
  }

  function injectStyles() {
    const css = `
.rv-note{font-size:14px;color:var(--muted);background:#fff;border:1px dashed var(--border);border-radius:8px;padding:8px 12px}
.rv-warn{color:#8a4b00;background:#fff8e6;border-style:solid;border-color:#f0d080}
.rv-banner{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;background:#fff8e6;border:1px solid #f0d080;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:14px}
.rv-caption-wrap{display:flex;flex-direction:column;gap:8px}
.rv-caption{width:100%;font:inherit;line-height:1.55;color:var(--navy);background:#fff;border:1.5px solid var(--border);border-radius:10px;padding:12px 14px;resize:vertical}
.rv-caption:focus,.rv-notes:focus{outline:none;border-color:var(--orange)}
.rv-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.rv-count{margin-left:auto;font-size:13px;color:var(--muted)}
.rv-count.rv-over{color:var(--orange);font-weight:700}
.rv-key{font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 10px}
.rv-key-warn{flex-basis:100%;color:#8a4b00}
.rv-fig-tools{padding:0 10px 10px;display:flex;flex-direction:column;gap:6px}
.rv-pick{font:inherit;font-size:13px;font-weight:700;min-height:36px;border:1.5px solid var(--border);border-radius:8px;background:#fff;color:var(--navy);cursor:pointer}
.rv-pick.on{background:#e8f5ee;border-color:var(--approved);color:var(--approved)}
.rv-rate{display:flex;gap:6px}
.rv-rate-btn{flex:1;min-height:40px;border:1.5px solid var(--border);border-radius:8px;background:#fff;cursor:pointer;font-size:18px;line-height:1}
.rv-rate-btn span{filter:grayscale(1);opacity:.55}
.rv-rate-btn:hover span,.rv-rate-btn.on span{filter:none;opacity:1}
.rv-rate-btn:focus-visible,.rv-pick:focus-visible{outline:2px solid var(--orange);outline-offset:1px}
.rv-rate-btn.on[data-val="loved-it"]{background:#e8f5ee;border-color:var(--approved)}
.rv-rate-btn.on[data-val="ok"]{background:#e8f0fb;border-color:var(--brand)}
.rv-rate-btn.on[data-val="brief-missed"]{background:#fff1ea;border-color:var(--orange)}
figure.selected{box-shadow:0 0 0 3px rgba(26,138,74,.15)}
body.rv-has-bar .images{grid-template-columns:repeat(3,minmax(0,1fr))}
.rv-notes-wrap h2 .rv-opt{font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)}
.rv-check{display:flex;align-items:center;gap:8px;font-size:15px;margin-bottom:8px;cursor:pointer}
.rv-check input{width:18px;height:18px;accent-color:var(--orange)}
.rv-notes{width:100%;font:inherit;font-size:15px;background:#fff;border:1.5px solid var(--border);border-radius:8px;padding:8px 12px;resize:vertical}
.rv-btn-ghost{font:inherit;font-size:13px;font-weight:600;background:#fff;color:var(--navy);border:1.5px solid var(--border);border-radius:8px;padding:6px 12px;cursor:pointer;min-height:34px}
.rv-btn-ghost:hover{border-color:var(--navy)}
.rv-btn-secondary{font:inherit;font-weight:700;background:#fff;color:var(--navy);border:1.5px solid var(--navy);border-radius:8px;padding:10px 16px;cursor:pointer}
.rv-btn-primary{font:inherit;font-weight:800;letter-spacing:.3px;background:var(--orange);color:#fff;border:0;border-radius:8px;padding:11px 20px;cursor:pointer;min-width:150px}
.rv-btn-primary:hover{background:#d94e20}
.rv-btn-primary:disabled,.rv-btn-secondary:disabled{background:#c5ccd8;border-color:#c5ccd8;color:#fff;cursor:not-allowed}
.rv-bar{position:fixed;left:0;right:0;bottom:0;z-index:50;background:#fff;border-top:1px solid var(--border);box-shadow:0 -4px 16px rgba(15,29,53,.08);padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.rv-bar-status{font-size:14px;color:var(--muted)}
.rv-dot{font-weight:700}
.rv-dot::before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;background:#8a9ab5;margin-right:6px;vertical-align:1px}
.rv-dot.status-ready_for_review::before{background:var(--review)}
.rv-dot.status-approved::before{background:var(--approved)}
.rv-unsaved{color:#8a4b00}
.rv-bar-actions{display:flex;gap:8px;align-items:center;margin-left:auto}
body.rv-has-bar main{padding-bottom:120px}
.rv-toast{position:fixed;left:50%;bottom:84px;transform:translateX(-50%) translateY(20px);opacity:0;pointer-events:none;background:var(--navy);color:#fff;padding:10px 18px;border-radius:24px;font-size:14px;font-weight:600;max-width:calc(100vw - 32px);text-align:center;transition:opacity .2s,transform .2s;z-index:60}
.rv-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.rv-toast.error{background:#c62828}
@media (max-width:520px){.rv-bar-actions{width:100%}.rv-btn-primary{flex:1}
body.rv-has-bar .images{gap:6px}
body.rv-has-bar figcaption{font-size:12px;padding:6px 6px}
body.rv-has-bar figcaption a{white-space:nowrap}
.rv-fig-tools{padding:0 6px 6px;gap:4px}
.rv-rate{gap:3px}
.rv-rate-btn{min-height:36px;font-size:15px;border-radius:6px}
.rv-pick{font-size:12px;min-height:32px;border-radius:6px}}
`;
    document.head.append(el('style', {}, css));
  }
})();
