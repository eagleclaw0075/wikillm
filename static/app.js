'use strict';

/* WikiLLM front end.
 *
 * Every page is assembled from several small requests to the configured model
 * (outline -> introduction -> infobox -> one request per section -> see also
 * -> categories), streamed into a Wikipedia-style layout as it arrives, then
 * saved by the local server so that revisiting a page is instant.
 */

// ------------------------------------------------------------------ basics

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
const escText = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = s => escText(s).replace(/"/g, '&quot;');

const LENGTHS = {
  short: { min: 3, max: 4, lead: 'one paragraph', section: 'one paragraph', leadChars: 500, sectionChars: 600 },
  standard: { min: 4, max: 6, lead: 'two paragraphs', section: 'two or three paragraphs', leadChars: 900, sectionChars: 1500 },
  long: {
    min: 6, max: 9, lead: 'three paragraphs',
    section: 'three to five paragraphs, split under "### " subheadings where that helps',
    leadChars: 1400, sectionChars: 2600,
  },
};

const SAMPLE_TOPICS = [
  'Rhinoceros', 'Roman Empire', 'Photosynthesis', 'Jazz', 'Black hole', 'Mount Everest',
  'Printing press', 'Octopus', 'Ada Lovelace', 'Silk Road', 'Volcano', 'Chess',
  'Large language model', 'Coffee', 'Aurora', 'Bicycle',
];

const state = {
  config: null,   // settings, as stored by the server
  pages: [],      // index of generated pages
  run: null,      // the generation in progress, if any
  from: null,     // article whose link was just clicked (disambiguation hint)
  current: null,  // { type, title } of the page on screen
};

class ModelError extends Error {
  constructor(message, detail) { super(message); this.detail = detail || ''; }
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refreshPages() {
  state.pages = (await api('GET', '/api/pages')).pages;
}

async function getPage(title) {
  try {
    return await api('GET', '/api/page?title=' + encodeURIComponent(title));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ------------------------------------------------------------------ titles

const ucfirst = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sameTitle = (a, b) => a.toLowerCase() === b.toLowerCase();

function normTitle(raw) {
  const t = String(raw).replace(/_/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const ns = t.match(/^(category|special)\s*:\s*(.*)$/i);
  if (ns) return ucfirst(ns[1].toLowerCase()) + ':' + ucfirst(ns[2]);
  return ucfirst(t);
}

function titlePath(title) {
  return '/wiki/' + encodeURIComponent(title.replace(/ /g, '_'))
    .replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%2C/gi, ',');
}

function pathTitle() {
  let p = location.pathname.replace(/^\/wiki\/?/, '');
  try { p = decodeURIComponent(p); } catch (e) { /* keep the raw path */ }
  return normTitle(p) || 'Main Page';
}

const link = (title, label) => `<a href="${escAttr(titlePath(normTitle(title)))}">${escText(label || title)}</a>`;

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) +
    ', at ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------------ model text -> HTML

/** Remove a reasoning model's <think> block from the visible text. */
function stripThinking(raw) {
  const close = raw.lastIndexOf('</think>');
  if (close >= 0) return raw.slice(close + 8);
  const open = raw.indexOf('<think>');
  return open >= 0 ? raw.slice(0, open) : raw;
}

function tidy(raw) {
  return stripThinking(String(raw)).replace(/\r/g, '')
    .replace(/^\s*```[a-z]*\s*$/gim, '')
    .replace(/^\s*(?:here(?:'s| is| are)|sure|certainly|okay|of course)\b[^\n]*:\s*\n/i, '')
    .trim();
}

/** Strip markup from a short string such as a heading or a list entry. */
function plain(s) {
  return String(s)
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/^\s*#+\s*/, '').replace(/^\s*=+\s*|\s*=+\s*$/g, '')
    .replace(/\*\*|'''?|__|`/g, '')
    .replace(/\s*[:：]\s*$/, '')
    .trim();
}

function wikiLink(inner, trail, ctx) {
  const parts = inner.split('|');
  let target = parts[0].replace(/\*\*|'''?/g, '').trim();
  const leadingColon = target.startsWith(':');
  if (leadingColon) target = target.slice(1).trim();
  if (/^(file|image|media)\s*:/i.test(target)) return '';
  if (/^category\s*:/i.test(target) && !leadingColon) return '';
  target = target.split('#')[0].trim();
  const label = ((parts.length > 1 ? parts.slice(1).join('|') : parts[0])
    .replace(/\*\*|'''?/g, '').replace(/^:/, '').trim() || target) + trail;
  if (!target) return escText(label);
  const title = normTitle(target);
  if (ctx.self && sameTitle(title, ctx.self)) return `<a class="selflink">${escText(label)}</a>`;
  return `<a href="${escAttr(titlePath(title))}" title="${escAttr(title)}">${escText(label)}</a>`;
}

const L0 = '', L1 = '';
const LINK_TOKEN = new RegExp(L0 + '(\\d+)' + L1, 'g');

function renderInline(src, ctx) {
  ctx = ctx || {};
  const links = [];
  const stash = html => { links.push(html); return L0 + (links.length - 1) + L1; };
  let s = String(src)
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<ref[^>]*\/?>/gi, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[(?:\d{1,3}|citation needed)\]/gi, '')
    .replace(/<br\s*\/?>/gi, ' ');
  // [[Target|label]] links, including a "link trail" such as [[rhinoceros]]es
  s = s.replace(/\[\[([^\[\]\n]+)\]\]([a-z]*)/g, (m, inner, trail) => stash(wikiLink(inner, trail, ctx)));
  // Markdown links: models sometimes write [label](url); treat the label as the article
  s = s.replace(/\[([^\[\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, (m, label) => stash(wikiLink(label, '', ctx)));
  s = escText(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/'''''(.+?)'''''/g, '<b><i>$1</i></b>')
    .replace(/'''(.+?)'''/g, '<b>$1</b>')
    .replace(/''(.+?)''/g, '<i>$1</i>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g,
      (m, pre, body) => (/\s$/.test(body) ? m : pre + '<i>' + body + '</i>'))
    .replace(/(^|[\s(])_(?=\S)([^_\n]+?)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  return s.replace(LINK_TOKEN, (m, i) => links[+i]);
}

/** Split a "| a | b |" table row, leaving pipes inside [[links]] alone. */
function splitCells(line) {
  const cells = [];
  let cur = '', depth = 0;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const two = body.substr(i, 2);
    if (two === '[[') { depth++; cur += two; i++; }
    else if (two === ']]') { depth = Math.max(0, depth - 1); cur += two; i++; }
    else if (body[i] === '|' && !depth) { cells.push(cur.trim()); cur = ''; }
    else cur += body[i];
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Render a block of model output (Markdown with a little wikitext tolerance).
 * ctx.self        title of the page (links to it become bold text)
 * ctx.skip        headings to drop, e.g. the section's own heading if repeated
 * ctx.noHeadings  drop every heading (used for the introduction)
 */
function renderBlocks(src, ctx) {
  ctx = ctx || {};
  const skip = (ctx.skip || []).map(s => s.toLowerCase());
  const out = [];
  let list = null, table = null;

  const closeList = () => {
    if (!list) return;
    out.push(`<${list.tag}>` + list.items.map(i => '<li>' + renderInline(i, ctx) + '</li>').join('') + `</${list.tag}>`);
    list = null;
  };
  const closeTable = () => {
    if (!table) return;
    const rows = table.map(splitCells);
    const isRule = r => r.every(c => /^:?-{2,}:?$/.test(c));
    const head = rows.length > 1 && isRule(rows[1]) ? rows[0] : null;
    const body = rows.filter((r, i) => !isRule(r) && !(head && i === 0));
    const cells = (r, tag) => '<tr>' + r.map(c => `<${tag}>` + renderInline(c, ctx) + `</${tag}>`).join('') + '</tr>';
    out.push('<table class="wikitable">' + (head ? cells(head, 'th') : '') + body.map(r => cells(r, 'td')).join('') + '</table>');
    table = null;
  };

  for (const line of tidy(src).split('\n')) {
    const t = line.trim();
    if (table && !t.startsWith('|')) closeTable();
    if (!t) continue;
    if (/^```/.test(t) || /^([-*_])\1{2,}$/.test(t)) { closeList(); continue; }
    if (skip.length && skip.includes(plain(t.replace(/^[-*•+]\s+/, '')).toLowerCase())) continue;

    if (t.startsWith('|') && t.length > 2) { closeList(); (table = table || []).push(t); continue; }

    const h = t.match(/^(#{1,6})\s+(.+?)\s*#*$/) || t.match(/^(={2,6})\s*(.+?)\s*=+$/);
    const boldLine = !h && t.match(/^(?:\*\*|''')([^*']{2,70})(?:\*\*|''')\s*:?$/);
    if (h || boldLine) {
      closeList();
      const text = plain(h ? h[2] : boldLine[1]);
      if (ctx.noHeadings || !text || skip.includes(text.toLowerCase())) continue;
      const tag = h && h[1].length >= 4 ? 'h4' : 'h3';
      out.push(`<${tag}>${escText(text)}</${tag}>`);
      continue;
    }

    const ul = t.match(/^[-*•+]\s+(.*)$/);
    const ol = !ul && t.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) closeList();
      list = list || { tag, items: [] };
      list.items.push((ul || ol)[1]);
      continue;
    }
    closeList();

    if (t.startsWith('>')) { out.push('<blockquote><p>' + renderInline(t.replace(/^>\s*/, ''), ctx) + '</p></blockquote>'); continue; }
    out.push('<p>' + renderInline(t, ctx) + '</p>');
  }
  closeList();
  closeTable();
  return out.join('\n');
}

/** Parse a model reply that should be a plain list of names, one per line. */
function listLines(raw, opts) {
  opts = opts || {};
  let lines = tidy(raw).split('\n').filter(l => l.trim());
  if (lines.length === 1 && lines[0].includes(';')) lines = lines[0].split(';');
  const seen = new Set(), out = [];
  for (let l of lines) {
    l = plain(l.trim().replace(/^(?:[-*•+]|\d+[.)])\s*/, '')).replace(/^category\s*:\s*/i, '');
    l = l.split(/\s+[–—-]\s+/)[0].replace(/[.;,]+$/, '').trim();
    if (!l || l.length > 80 || l.split(' ').length > 10) continue;
    if (/^(here|sure|certainly|okay|these|the following|none$|n\/a$)\b/i.test(l)) continue;
    if (opts.exclude && opts.exclude.test(l)) continue;
    if (opts.self && sameTitle(normTitle(l), opts.self)) continue;
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(opts.keepCase ? l : ucfirst(l));   // link lists keep the model's own capitalisation
    if (out.length >= (opts.max || 12)) break;
  }
  return out;
}

function parseInfobox(raw) {
  const rows = [];
  for (let line of tidy(raw).split('\n')) {
    line = line.trim().replace(/^[-*•+]\s+/, '');
    let label, value;
    if (line.startsWith('|')) {
      const cells = splitCells(line);
      if (cells.length < 2 || /^:?-+:?$/.test(cells[0])) continue;
      label = cells[0]; value = cells[1];
    } else {
      const m = line.match(/^([^:]{2,60}?)\s*:\s*(.+)$/);
      if (!m) continue;
      label = m[1]; value = m[2];
    }
    label = plain(label);
    value = value.replace(/^\*\*\s*|\s*\*\*$/g, '').trim();
    if (!label || !value || value.length > 220 || label.split(' ').length > 5) continue;
    if (/^(label|infobox|field|key|value)$/i.test(label)) continue;
    rows.push([ucfirst(label), value]);
    if (rows.length >= 10) break;
  }
  return rows;
}

function extractSvg(raw) {
  const m = tidy(raw).match(/<svg[\s\S]*<\/svg>/i);
  if (!m) return '';
  let svg = m[0].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  if (!/xmlns=/.test(svg)) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}

/** True once a model has started repeating whole paragraphs (small models do). */
function isLooping(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  lines.pop();                       // the last line may still be arriving
  const seen = new Set();
  for (const l of lines) {
    if (l.length < 60) continue;
    if (seen.has(l)) return true;
    seen.add(l);
  }
  return false;
}

/**
 * Watches a model's reasoning as it streams in and reports when it is going round in circles.
 * Healthy reasoning re-drafts a sentence a handful of times; a stuck model repeats it until
 * its token budget is gone. Returns a function to call with the reasoning so far.
 */
function createLoopWatch(limit = 8) {
  const counts = new Map();
  let pos = 0;
  return text => {
    const sentence = /[^\n.?!]+[.?!]*/g;
    sentence.lastIndex = pos;
    let m;
    while ((m = sentence.exec(text))) {
      if (sentence.lastIndex >= text.length) break;      // may still be arriving
      pos = sentence.lastIndex;
      const s = m[0].trim();
      if (s.length < 60) continue;
      const n = (counts.get(s) || 0) + 1;
      if (n >= limit) return true;
      counts.set(s, n);
    }
    return false;
  };
}

/** Tidy up a finished piece of prose: drop repeated paragraphs and half sentences. */
function finishProse(reply) {
  let lines = reply.text.split('\n');
  if (reply.looped) lines.pop();
  const seen = new Set();
  lines = lines.filter(l => {
    const key = l.trim();
    if (key.length < 60) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  if (reply.finish === 'length' && !reply.looped) {
    const cut = text.replace(/[^.!?。]*$/, '');
    if (cut.length > text.length * 0.5) text = cut;
  }
  return text.trim();
}

// ------------------------------------------------------------------ talking to the model

function startRun() {
  cancelRun();
  state.run = { abort: new AbortController(), alive: true, stopped: false, tokens: 0, firstTokenAt: 0 };
  return state.run;
}

function cancelRun() {
  const run = state.run;
  if (!run) return;
  run.alive = false;
  run.abort.abort();
  if (run.progress) run.progress.stop();
  state.run = null;
}

/** One streamed chat completion through the local proxy. */
async function chat(run, messages, onUpdate, limits, extra) {
  limits = limits || {};
  let res;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, ...extra }),
      signal: run.abort.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ModelError('Could not reach the WikiLLM server. Is server.py still running?');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ModelError(data.error || ('Request failed: HTTP ' + res.status), data.detail);
  }

  let raw = '', thinking = '', finish = null, tokens = 0, looped = false, ended = false, stuck = null;
  let chunks = 0, reported = 0;
  const count = () => {
    chunks++;
    if (!run.firstTokenAt) run.firstTokenAt = performance.now();
    // A chunk can carry several tokens, so until the server reports the real number
    // go by the chunk count or the amount of text, whichever is larger.
    const estimate = Math.max(chunks, Math.round((raw.length + thinking.length) / 4));
    run.tokens += estimate - tokens;
    tokens = estimate;
  };
  const circling = createLoopWatch();
  const update = () => {
    const text = tidy(raw);
    if (onUpdate) {
      onUpdate({
        text,
        thinking: (!raw.trim() && !!thinking) || (raw.includes('<think>') && !raw.includes('</think>')),
        thinkChars: thinking.length + raw.length,
      });
    }
    return text;
  };

  if ((res.headers.get('content-type') || '').includes('application/json')) {
    // The server ignored "stream": the whole reply arrives at once.
    const data = await res.json();
    const choice = (data.choices || [])[0] || {};
    raw = (choice.message && choice.message.content) || '';
    finish = choice.finish_reason || null;
    tokens = (data.usage && data.usage.completion_tokens) || Math.round(raw.length / 4);
    run.tokens += tokens;
    update();
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { ended = true; continue; }
        if (!payload) continue;
        let data;
        try { data = JSON.parse(payload); } catch (e) { continue; }
        if (data.error) throw new ModelError((data.error && data.error.message) || JSON.stringify(data.error));
        if (data.usage && data.usage.completion_tokens) reported = data.usage.completion_tokens;
        const choice = (data.choices || [])[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        const reasoning = delta.reasoning_content || delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) { thinking += reasoning; count(); }
        if (typeof delta.content === 'string' && delta.content) { raw += delta.content; count(); }
        if (choice.finish_reason) { finish = choice.finish_reason; ended = true; }
      }
      // Stop a reply that has run far past what was asked for, or is going round in circles.
      const text = update();
      looped = !!limits.prose && isLooping(text);
      // Reasoning that keeps repeating itself never reaches an answer: give up on it now
      // rather than after the whole token budget, so the request can be tried again.
      const openThink = raw.includes('<think>') && !raw.includes('</think>');
      if (!text && circling(thinking || (openThink ? raw : ''))) stuck = 'loop';
      if (stuck || looped || (limits.maxChars && text.length > limits.maxChars)) {
        finish = 'length';
        ended = true;
        reader.cancel().catch(() => {});
        break;
      }
    }
    // A stream that just stops is a dropped connection, not a finished reply.
    if (!ended) throw new ModelError('The model server closed the connection before finishing its reply.');
    if (reported) { run.tokens += reported - tokens; tokens = reported; }
  }
  const text = tidy(raw);
  // The whole budget went on reasoning and nothing was written.
  if (!stuck && finish === 'length' && !text && (thinking || raw.includes('<think>'))) stuck = 'budget';
  return { text, raw, thinking, finish, tokens, looped, stuck };
}

function systemPrompt(cfg) {
  return [
    'You are the writing engine of an encyclopedia. You write in the neutral, factual, formal style of Wikipedia, using only what you know.',
    'Rules:',
    '- Output only the text that was asked for: no greetings, no commentary, no notes about yourself, no closing remarks.',
    '- Mark links to other encyclopedia articles by wrapping the words in double square brackets, for example [[Africa]], [[keratin]] or [[black rhinoceros|black rhinos]]. Link the first mention of people, places, organisations, species, works, events and technical concepts that would have their own article. Use several links in every paragraph.',
    '- Capitalise only proper nouns. Linked words keep the capitalisation they would have without the link: [[savanna]], [[natural selection]] and [[printing press]] are lower case, while [[Charles Darwin]] and [[South Africa]] are capitalised. Never write a link, heading or list entry in Title Case.',
    '- Separate paragraphs with a blank line. Do not use citations, footnotes, reference numbers, URLs or images.',
    (cfg.extraInstructions || '').trim(),
  ].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------ progress display

const clock = secs => Math.floor(secs / 60) + ':' + String(Math.floor(secs % 60)).padStart(2, '0');

/** Progress across all the requests that make up a page. Several can be in flight at once. */
function createProgress(run, heading) {
  $('#notice').innerHTML =
    '<div class="mbox" id="gen-box"><div class="body"><div class="title"></div>' +
    '<div class="progress"><div></div></div><div class="detail"></div></div>' +
    '<button type="button" class="btn">Stop</button></div>';
  const box = $('#gen-box'), bar = $('.progress > div', box);
  const top = $('#topbar'), topFill = $('#topbar-fill');
  top.classList.add('active');
  topFill.style.width = '0';
  $('button', box).onclick = () => { run.stopped = true; run.abort.abort(); };

  const started = performance.now();
  let steps = [], shown = 0;
  const live = new Map();     // step id -> { label, mode, frac, done }

  const paint = () => {
    if (!run.alive || !box.isConnected) return;
    const total = steps.reduce((a, s) => a + s.w, 0) || 1;
    let got = 0, finished = 0;
    const active = [];
    for (const s of steps) {
      const st = live.get(s.id);
      if (!st) continue;
      if (st.done) { got += s.w; finished++; continue; }
      got += s.w * st.frac;
      active.push(st.label + (st.mode === 'thinking' ? ' (thinking)' : st.mode === 'waiting' ? ' (waiting)' : ''));
    }
    shown = Math.max(shown, Math.min(0.99, got / total));
    const pct = Math.round(shown * 100);
    bar.style.width = topFill.style.width = Math.max(pct, 2) + '%';
    $('.title', box).textContent = `${heading} — ${pct}%`;
    const now = active.length > 3 ? active.slice(0, 3).join(', ') + ` and ${active.length - 3} more` : active.join(', ');
    const bits = [`${finished} of ${steps.length} requests done` + (now ? `, now on ${now}` : '')];
    if (run.tokens) {
      const secs = (performance.now() - run.firstTokenAt) / 1000;
      bits.push(`${run.tokens.toLocaleString()} tokens`);
      if (secs > 1) bits.push(`${(run.tokens / secs).toFixed(1)} tokens/s`);
    }
    bits.push(clock((performance.now() - started) / 1000) + ' elapsed');
    $('.detail', box).textContent = bits.join(' · ');
  };
  const timer = setInterval(paint, 500);

  const progress = {
    plan(list) { steps = list; paint(); },
    begin(id, label) { live.set(id, { label, mode: 'waiting', frac: 0, done: false }); paint(); },
    feed(id, u) {
      const st = live.get(id), step = steps.find(s => s.id === id);
      if (!st || !step) return;
      st.mode = u.thinking ? 'thinking' : 'writing';
      const f = u.thinking ? Math.min(0.3, u.thinkChars / 40000) : Math.min(0.95, 0.3 + 0.65 * u.text.length / step.expect);
      st.frac = Math.max(st.frac, f);
      paint();
    },
    end(id) { const st = live.get(id); if (st) st.done = true; paint(); },
    stop() { clearInterval(timer); top.classList.remove('active'); },
    finish() {
      clearInterval(timer);
      bar.style.width = topFill.style.width = '100%';
      setTimeout(() => { top.classList.remove('active'); if (box.isConnected) box.remove(); }, 500);
    },
    elapsedMs: () => Math.round(performance.now() - started),
  };
  run.progress = progress;
  return progress;
}

/**
 * Runs queued requests with at most `limit` in flight, lowest priority number first.
 * With a limit of 1 a page is written strictly top to bottom.
 */
function createPool(limit) {
  const queue = [];
  let active = 0;
  const pump = () => {
    queue.sort((a, b) => a.priority - b.priority);
    while (active < limit && queue.length) {
      const job = queue.shift();
      active++;
      // Free the slot on a later tick, so that whatever the finished request unblocks
      // has been queued and can compete for the slot on priority.
      job.fn().then(job.resolve, job.reject).finally(() => { active--; setTimeout(pump, 0); });
    }
  };
  return (priority, fn) => new Promise((resolve, reject) => {
    queue.push({ priority, fn, resolve, reject });
    setTimeout(pump, 0);
  });
}

function poolSize(cfg) {
  return Math.max(1, Math.min(6, parseInt(cfg.parallel, 10) || 6));
}

/** The next reasoning effort down, for asking again after a request got stuck in its reasoning. */
const LOWER_EFFORT = { '': 'medium', high: 'medium', medium: 'low', low: 'low' };
const MAX_TRIES = 3;

/**
 * Build the helper that sends one request and records it in the page's log.
 * spec: { id, priority, label (short, for the progress line), step (long, for View source),
 *         prompt, onStart, onText, limits }
 * A request whose reasoning goes round in circles, or uses up the whole token budget without
 * writing anything, is asked again with less reasoning effort. Every try is kept in the log.
 */
function makeAsk(run, progress, rec, sys, pool, cfg) {
  return spec => pool(spec.priority, async () => {
    if (spec.onStart) spec.onStart();
    let effort = (cfg && cfg.reasoning) || '';
    for (let attempt = 1; ; attempt++) {
      progress.begin(spec.id, spec.label + (attempt > 1 ? `, try ${attempt}` : ''));
      const t0 = performance.now();
      const reply = await chat(run, [{ role: 'system', content: sys }, { role: 'user', content: spec.prompt }], u => {
        progress.feed(spec.id, u);
        if (spec.onText && !u.thinking) spec.onText(u.text);
      }, spec.limits, attempt > 1 ? { reasoning_effort: effort } : null);
      const entry = {
        order: spec.priority, step: spec.step, prompt: spec.prompt, response: reply.raw, thinking: reply.thinking,
        finish: reply.finish, looped: reply.looped, tokens: reply.tokens, ms: Math.round(performance.now() - t0),
      };
      if (attempt > 1) { entry.attempt = attempt; entry.effort = effort; }
      rec.log.push(entry);
      if (reply.stuck && attempt < MAX_TRIES) {
        effort = LOWER_EFFORT[effort] || 'medium';
        entry.stuck = reply.stuck;
        entry.retryEffort = effort;
        continue;
      }
      if (reply.stuck) entry.stuck = reply.stuck;
      progress.end(spec.id);
      return reply;
    }
  });
}

/**
 * Start requests that may overlap. spawn(spec, onDone) sends one; the first failure
 * cancels the rest and is what all() and firstError() report.
 */
function createTasks(run, ask) {
  const tasks = [];
  let failure = null;
  return {
    spawn(spec, onDone) {
      const p = ask(spec).then(onDone).catch(err => {
        if (!failure) failure = err;
        run.abort.abort();
        throw err;
      });
      p.catch(() => {});          // reported through all(); avoid "unhandled rejection" noise
      tasks.push(p);
      return p;
    },
    all: () => Promise.all(tasks),
    firstError: () => failure,
  };
}

function failRun(run, err, title) {
  if (run.progress) run.progress.stop();
  if (!run.alive) return;            // the reader went somewhere else
  run.alive = false;
  state.run = null;
  $$('.streaming').forEach(el => el.classList.remove('streaming'));
  $$('.skeleton').forEach(el => el.classList.add('idle'));
  $$('#toc li.writing').forEach(el => { el.className = 'pending'; });
  const retry = `<a class="btn" href="${escAttr(titlePath(title))}?action=regenerate" style="line-height:28px">Try again</a>`;
  if (run.stopped) {
    $('#notice').innerHTML = '<div class="mbox warn"><div class="body"><div class="title">Generation stopped</div>' +
      '<div class="detail">What was written so far is shown below. It has not been saved.</div></div>' + retry + '</div>';
    return;
  }
  if (err.name === 'AbortError') return;
  console.error(err);
  $('#notice').innerHTML = '<div class="mbox error"><div class="body"><div class="title">The model could not finish this page</div>' +
    `<div>${escText(err.message || String(err))}</div>` +
    (err.detail ? `<pre>${escText(err.detail)}</pre>` : '') +
    '<div class="detail">Check that your model server is running and that the right model is selected in ' +
    '<a href="/wiki/Special:Settings">Model settings</a>.</div></div>' + retry + '</div>';
}

// ------------------------------------------------------------------ page chrome

function chrome(opts) {
  const { title, ns, actions, action } = opts;
  document.title = (title === 'Main Page' ? '' : title + ' - ') + 'WikiLLM';
  $('#firstHeading').textContent = opts.heading || title;
  $('#firstHeading').hidden = !!opts.hideHeading;
  const base = escAttr(titlePath(title));
  const tab = (name, href, selected) =>
    selected ? `<span class="selected">${name}</span>` : `<a href="${href}">${name}</a>`;
  let right = '';
  if (actions) {
    right = tab('Read', base, action !== 'source') + tab('View source', base + '?action=source', action === 'source') +
      tab('Regenerate', base + '?action=regenerate') + tab('Delete', base + '?action=delete');
  }
  $('#tabs').innerHTML = `<div class="group"><span class="selected">${escText(ns)}</span></div><div class="group">${right}</div>`;
  $('#siteSub').textContent = opts.sub === undefined ? 'From WikiLLM, the generated encyclopedia' : opts.sub;
  $('#notice').innerHTML = '';
  $('#content').innerHTML = '';
  $('#catlinks').hidden = true;
  $('#toc').hidden = true;
  $('#footer-info').textContent = opts.footer || '';
}

function pageFooter(rec) {
  let s = `This page was generated on ${formatDate(rec.generatedAt)} by ${rec.model}`;
  if (rec.durationMs >= 1500) s += ` in ${Math.round(rec.durationMs / 1000)} seconds`;
  if (rec.tokens) s += ` (about ${rec.tokens.toLocaleString()} tokens)`;
  return s + '.';
}

function showCatlinks(cats) {
  const el = $('#catlinks');
  el.hidden = !cats.length;
  el.innerHTML = `<a href="/wiki/Special:AllPages">Categories</a>: <ul>` +
    cats.map(c => '<li>' + link('Category:' + c, c) + '</li>').join('') + '</ul>';
}

// ------------------------------------------------------------------ articles

const SKELETON = '<div class="skeleton"><span></span><span></span><span></span></div>';

/** The live article layout. Each part can be filled, or refilled while streaming. */
function articleView(title) {
  $('#content').innerHTML = '<div id="p-infobox"></div><div id="p-lead"></div><div id="p-sections"></div><div id="p-seealso"></div><div id="p-trace"></div>';
  let outline = [], hasSeeAlso = false;
  const status = [];

  const fill = (el, html, st, emptyNote) => {
    el.classList.toggle('streaming', st === 'writing' && !!html);
    if (html) el.innerHTML = html;
    else if (st === 'done') el.innerHTML = emptyNote ? `<p class="empty">${emptyNote}</p>` : '';
    else el.innerHTML = SKELETON.replace('skeleton', st === 'writing' ? 'skeleton' : 'skeleton idle');
  };

  const toc = () => {
    const el = $('#toc');
    el.hidden = false;
    el.innerHTML = '<div class="toc-heading">Contents</div><ul><li><a href="#top">(Top)</a></li>' +
      outline.map((name, i) => `<li class="${status[i] === 'done' ? '' : status[i] || 'pending'}"><a href="#sec-${i}">${escText(name)}</a></li>`).join('') +
      (hasSeeAlso ? '<li><a href="#sec-seealso">See also</a></li>' : '') + '</ul>';
  };

  return {
    setLead(raw, st) {
      fill($('#p-lead'), renderBlocks(raw, { self: title, noHeadings: true }), st);
    },
    setInfobox(rows, image, model) {
      if (!rows.length && !image) { $('#p-infobox').innerHTML = ''; return; }
      const ctx = { self: title };
      let html = `<table class="infobox"><tbody><tr><th colspan="2" class="above">${escText(title)}</th></tr>`;
      if (image) {
        html += `<tr><td colspan="2" class="image"><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(image)}"></td></tr>` +
          `<tr><td colspan="2" class="caption">${escText(title)}, as drawn by ${escText(model || 'the model')}</td></tr>`;
      }
      html += rows.map(r => `<tr><th scope="row">${escText(r[0])}</th><td>${renderInline(r[1], ctx)}</td></tr>`).join('');
      $('#p-infobox').innerHTML = html + '</tbody></table>';
    },
    setOutline(list) {
      outline = list;
      $('#p-sections').innerHTML = list.map((name, i) =>
        `<h2 id="sec-${i}">${escText(name)}</h2><div class="sec-body" id="sec-body-${i}">${SKELETON.replace('skeleton', 'skeleton idle')}</div>`).join('');
      list.forEach((n, i) => { status[i] = 'pending'; });
      toc();
    },
    setSection(i, raw, st) {
      const html = renderBlocks(raw, { self: title, skip: [outline[i], title] });
      fill($('#sec-body-' + i), html, st, 'The model returned no text for this section.');
      if (status[i] !== st) { status[i] = st; toc(); }
    },
    setSeeAlso(list, st) {
      const el = $('#p-seealso');
      if (!list.length && st === 'done') { el.innerHTML = ''; hasSeeAlso = false; toc(); return; }
      el.innerHTML = '<h2 id="sec-seealso">See also</h2><div></div>';
      fill(el.lastChild, list.length ? '<ul>' + list.map(t => '<li>' + link(normTitle(t), t) + '</li>').join('') + '</ul>' : '', st);
      if (!hasSeeAlso) { hasSeeAlso = true; toc(); }
    },
    setCategories: showCatlinks,
    setTrace: rec => showTrace($('#p-trace'), rec),
  };
}

function showArticle(rec) {
  chrome({ title: rec.title, ns: 'Article', actions: true, footer: pageFooter(rec) });
  state.current = { type: 'article', title: rec.title };
  const view = articleView(rec.title);
  view.setInfobox(rec.infobox || [], rec.image, rec.model);
  view.setLead(rec.lead, 'done');
  view.setOutline(rec.sections.map(s => s.title));
  rec.sections.forEach((s, i) => view.setSection(i, s.text, 'done'));
  view.setSeeAlso(rec.seeAlso || [], 'done');
  view.setCategories(rec.categories || []);
  view.setTrace(rec);
}

async function generateArticle(title, from) {
  const cfg = state.config;
  const L = LENGTHS[cfg.length] || LENGTHS.standard;
  const run = startRun();
  chrome({ title, ns: 'Article' });
  state.current = { type: 'article', title };
  const view = articleView(title);
  const rec = {
    type: 'article', title, from: from || '', model: cfg.model, length: cfg.length,
    outline: [], lead: '', infobox: [], image: '', sections: [], seeAlso: [], categories: [], log: [],
  };
  const progress = createProgress(run, `Writing “${title}” with ${cfg.model}`);
  const sys = systemPrompt(cfg);
  rec.system = sys;
  const tasks = createTasks(run, makeAsk(run, progress, rec, sys, createPool(poolSize(cfg)), cfg));

  const about = `Article title: ${title}` + (from
    ? `\n(The reader followed a link to this article from the article "${from}". Use that only to decide which meaning of the title is intended.)`
    : '');
  const plan = names => [
    { id: 'outline', w: 0.4, expect: 120 },
    { id: 'lead', w: 1, expect: L.leadChars },
    { id: 'infobox', w: 0.5, expect: 220 },
    ...names.map((n, i) => ({ id: 's' + i, w: 1.3, expect: L.sectionChars })),
    { id: 'seealso', w: 0.3, expect: 90 },
    { id: 'cats', w: 0.3, expect: 90 },
    ...(cfg.illustrations ? [{ id: 'image', w: 1.5, expect: 1800 }] : []),
  ];
  const emptyHint = 'If this is a reasoning model, it may have used its whole budget thinking. Try raising "Max tokens per request" or lowering "Reasoning effort" in Model settings.';

  /* What depends on what:
   *   outline, see also, categories, illustration   need only the title
   *   introduction                                  needs the outline
   *   infobox and every section                     need the outline and the introduction
   * Sections never see each other, so they can all be written at the same time.
   * Priorities follow reading order, which is the order used when only one request runs at a time.
   */
  try {
    progress.plan(plan(new Array(Math.round((L.min + L.max) / 2)).fill('')));
    view.setLead('', 'writing');

    // Needs only the title: these run alongside everything else.
    tasks.spawn({
      id: 'seealso', priority: 50, label: 'see also', step: 'Choosing “See also” links',
      prompt: `${about}\n\nList 4 to 6 titles of other encyclopedia articles that a reader of this article would want to read next, for its "See also" section. ` +
        'One title per line, without descriptions. Capitalise only proper nouns: an ordinary subject is written entirely in lower case, a name keeps its capitals. Output only the titles.',
      onText: text => { const l = listLines(text, { max: 8, self: title, keepCase: true }); if (l.length) view.setSeeAlso(l, 'writing'); },
      limits: { maxChars: 1200 },
    }, reply => {
      rec.seeAlso = listLines(reply.text, { max: 8, self: title, keepCase: true });
      view.setSeeAlso(rec.seeAlso, 'done');
    });
    tasks.spawn({
      id: 'cats', priority: 51, label: 'categories', step: 'Filing the article under categories',
      prompt: `${about}\n\nList 3 to 6 categories this article belongs to, in the style of Wikipedia categories ` +
        '(short plural phrases such as "Mammals of Africa" or "19th-century inventions"), from the most specific to the most general. ' +
        'One category per line. Capitalise only proper nouns. Output only the category names.',
      onText: text => view.setCategories(listLines(text, { max: 8, keepCase: true })),
      limits: { maxChars: 1200 },
    }, reply => {
      rec.categories = listLines(reply.text, { max: 8, keepCase: true });
      view.setCategories(rec.categories);
    });
    if (cfg.illustrations) {
      tasks.spawn({
        id: 'image', priority: 52, label: 'illustration', step: 'Drawing an illustration',
        prompt: `Draw a simple, clean SVG illustration of "${title}" for an encyclopedia infobox. Output only SVG code, starting with ` +
          '<svg viewBox="0 0 300 220" xmlns="http://www.w3.org/2000/svg"> and ending with </svg>. ' +
          'Use basic shapes and paths with flat colours. No text labels, no scripts, no external images.',
      }, reply => {
        rec.image = extractSvg(reply.text);
        view.setInfobox(rec.infobox, rec.image, rec.model);
      });
    }

    // Outline
    let reply = await tasks.spawn({
      id: 'outline', priority: 0, label: 'outline', step: 'Planning the sections',
      prompt: `${about}\n\nList the section headings for this encyclopedia article: between ${L.min} and ${L.max} headings, one per line, in the order they would appear. ` +
        'Capitalise only the first word and proper nouns ("Distribution and habitat", not "Distribution and Habitat"). ' +
        'Do not include an introduction, "See also", "References", "Further reading" or "External links". Output only the headings.',
      limits: { maxChars: 1200 },
    }, r => r);
    rec.outline = listLines(reply.text, {
      max: L.max, self: title,
      exclude: /^(introduction|intro|lead|summary|see also|references?|further reading|external links|notes|bibliography|sources|citations|conclusion)$/i,
    });
    if (!rec.outline.length) {
      if (!reply.text && !reply.raw.trim()) throw new ModelError('The model returned an empty reply.', emptyHint);
      rec.outline = ['Overview', 'History', 'Characteristics'];
    }
    progress.plan(plan(rec.outline));
    view.setOutline(rec.outline);
    const outlineText = rec.outline.map((n, i) => `${i + 1}. ${n}`).join('\n');

    // Introduction
    reply = await tasks.spawn({
      id: 'lead', priority: 1, label: 'introduction', step: 'Writing the introduction',
      prompt: `${about}\n\nSections that will follow the introduction:\n${outlineText}\n\n` +
        `Write the lead (introductory) section of this article: ${L.lead} summarising the subject. Begin by defining the subject, ` +
        'with its name in **bold** the first time it appears. Do not write a heading, and do not write any of the later sections.',
      onText: text => view.setLead(text, 'writing'),
      limits: { prose: true, maxChars: L.leadChars * 6 },
    }, r => r);
    rec.lead = finishProse(reply);
    view.setLead(rec.lead, 'done');
    if (!rec.lead) throw new ModelError('The model returned no text for the introduction.', emptyHint);

    // Infobox and all sections go out together.
    tasks.spawn({
      id: 'infobox', priority: 2, label: 'infobox', step: 'Collecting key facts for the infobox',
      prompt: `${about}\n\nIntroduction:\n${rec.lead}\n\n` +
        'Write the key facts for this article\'s infobox as 4 to 8 separate lines in the form "Label: value". ' +
        'Choose the labels a Wikipedia infobox for this kind of subject would have, and fill in the facts for this subject. ' +
        'Keep every value short: a few words, not a sentence. Values may contain [[links]]. Output only those lines.',
      onText: text => view.setInfobox(parseInfobox(text), rec.image, rec.model),
      limits: { maxChars: 1500 },
    }, r => {
      rec.infobox = parseInfobox(r.text);
      view.setInfobox(rec.infobox, rec.image, rec.model);
    });
    rec.outline.forEach((name, i) => {
      tasks.spawn({
        id: 's' + i, priority: 10 + i, label: `“${name}”`,
        step: `Writing section ${i + 1} of ${rec.outline.length}, “${name}”`,
        prompt: `${about}\n\nOutline of the article:\n${outlineText}\n\nIntroduction (already written):\n${rec.lead}\n\n` +
          `Write the section "${name}" (section ${i + 1} of ${rec.outline.length}): ${L.section}. ` +
          'Cover only what belongs under this heading. The other sections are written separately, so do not repeat them or the introduction. ' +
          'Do not write the heading itself. Use "- " bullet lists only where a list is clearly the natural form.',
        onStart: () => view.setSection(i, '', 'writing'),
        onText: text => view.setSection(i, text, 'writing'),
        limits: { prose: true, maxChars: L.sectionChars * 6 },
      }, r => {
        const text = finishProse(r);
        rec.sections[i] = { title: name, text };
        view.setSection(i, text, 'done');
      });
    });

    await tasks.all();

    rec.log.sort((a, b) => a.order - b.order);
    rec.log.forEach(entry => { delete entry.order; });
    rec.generatedAt = new Date().toISOString();
    rec.durationMs = progress.elapsedMs();
    rec.tokens = run.tokens;
    await api('PUT', '/api/page', rec);
    if (!run.alive) return;
    progress.finish();
    run.alive = false;
    state.run = null;
    await refreshPages();
    // Swap in the finished page's tabs and footer without redrawing the text.
    const keep = $('#content'), cats = $('#catlinks').innerHTML;
    const nodes = Array.from(keep.childNodes), tocHtml = $('#toc').innerHTML;
    chrome({ title, ns: 'Article', actions: true, footer: pageFooter(rec) });
    nodes.forEach(n => keep.appendChild(n));
    $('#toc').innerHTML = tocHtml; $('#toc').hidden = false;
    $('#catlinks').innerHTML = cats; $('#catlinks').hidden = !rec.categories.length;
    view.setTrace(rec);
  } catch (err) {
    const cause = tasks.firstError() || err;
    if (run.alive) run.abort.abort();      // cancel whatever is still in flight
    failRun(run, cause, title);
  }
}

// ------------------------------------------------------------------ categories

function alphaColumns(titles, toLink) {
  const groups = new Map();
  const sorted = Array.from(titles).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  for (const t of sorted) {
    const c = t.charAt(0);
    const key = /[a-z]/i.test(c) ? c.toUpperCase() : /\d/.test(c) ? '0–9' : c;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return '<div class="columns">' + Array.from(groups).map(([key, items]) =>
    `<div class="group"><h3>${escText(key)}</h3><ul>${items.map(t => '<li>' + toLink(t) + '</li>').join('')}</ul></div>`).join('') + '</div>';
}

function categoryBody(rec, writing) {
  const name = rec.title.slice('Category:'.length);
  // Articles already generated that were filed under this category belong here too.
  const filed = state.pages.filter(p => p.type === 'article' && (p.categories || []).some(c => sameTitle(c, name))).map(p => p.title);
  const pages = Array.from(new Map(filed.concat(rec.pages).map(t => [t.toLowerCase(), t])).values());
  let html = '';
  if (rec.subcats.length || (writing && writing.subcats)) {
    html += '<h2>Subcategories</h2>';
    html += rec.subcats.length
      ? `<p>This category has the following ${rec.subcats.length} subcategories.</p>` +
        alphaColumns(rec.subcats, t => link('Category:' + t, t))
      : SKELETON;
  }
  html += `<h2>Pages in category “${escText(name)}”</h2>`;
  if (pages.length) {
    html += `<p>The following ${pages.length} pages are in this category, according to ${escText(rec.model)}.</p>` +
      alphaColumns(pages, t => link(normTitle(t), t));
  } else {
    html += writing && writing.pages ? SKELETON : '<p class="empty">The model did not name any pages for this category.</p>';
  }
  $('#content').innerHTML = html;
}

function showCategory(rec) {
  chrome({ title: rec.title, ns: 'Category', actions: true, footer: pageFooter(rec) });
  state.current = { type: 'category', title: rec.title };
  categoryBody(rec, null);
}

async function generateCategory(title) {
  const cfg = state.config;
  const name = title.slice('Category:'.length);
  const run = startRun();
  chrome({ title, ns: 'Category' });
  state.current = { type: 'category', title };
  const rec = { type: 'category', title, model: cfg.model, pages: [], subcats: [], log: [], system: systemPrompt(cfg) };
  const progress = createProgress(run, `Filling “${title}” with ${cfg.model}`);
  const tasks = createTasks(run, makeAsk(run, progress, rec, rec.system, createPool(poolSize(cfg)), cfg));
  progress.plan([{ id: 'pages', w: 1, expect: 420 }, { id: 'subcats', w: 0.4, expect: 110 }]);
  const busy = { pages: true, subcats: true };     // the two lists are independent of each other
  try {
    categoryBody(rec, busy);
    tasks.spawn({
      id: 'pages', priority: 0, label: 'pages', step: 'Listing pages in this category',
      prompt: `List 15 to 30 titles of encyclopedia articles that belong in the category "${name}". ` +
        'One title per line, without descriptions or numbering. Capitalise only proper nouns. Output only the titles.',
      onText: text => { rec.pages = listLines(text, { max: 40, keepCase: true }); categoryBody(rec, busy); },
      limits: { maxChars: 3000 },
    }, reply => {
      rec.pages = listLines(reply.text, { max: 40, keepCase: true });
      busy.pages = false;
      categoryBody(rec, busy);
    });
    tasks.spawn({
      id: 'subcats', priority: 1, label: 'subcategories', step: 'Listing subcategories',
      prompt: `List up to 6 narrower subcategories of the category "${name}", named in the style of Wikipedia categories. ` +
        'One per line. Capitalise only proper nouns. If there are no sensible subcategories, output the single word NONE.',
      onText: text => { rec.subcats = listLines(text, { max: 8, self: title, keepCase: true }); categoryBody(rec, busy); },
      limits: { maxChars: 1200 },
    }, reply => {
      rec.subcats = listLines(reply.text, { max: 8, keepCase: true }).filter(c => !sameTitle(c, name));
      busy.subcats = false;
      categoryBody(rec, busy);
    });
    await tasks.all();

    rec.log.sort((a, b) => a.order - b.order);
    rec.log.forEach(entry => { delete entry.order; });
    rec.generatedAt = new Date().toISOString();
    rec.durationMs = progress.elapsedMs();
    rec.tokens = run.tokens;
    await api('PUT', '/api/page', rec);
    if (!run.alive) return;
    progress.finish();
    run.alive = false;
    state.run = null;
    await refreshPages();
    showCategory(rec);
  } catch (err) {
    const cause = tasks.firstError() || err;
    if (run.alive) run.abort.abort();
    failRun(run, cause, title);
  }
}

// ------------------------------------------------------------------ thinking trace and view source

/** The reasoning a model emitted for one request: a separate stream, or an inline <think> block. */
function stepThinking(step) {
  if (step.thinking) return step.thinking;
  const raw = step.response || '';
  const open = raw.indexOf('<think>');
  if (open < 0) return '';
  const close = raw.lastIndexOf('</think>');
  return raw.slice(open + 7, close > open ? close : raw.length).trim();
}

/** The short facts shown next to a request: tokens, time, and why it ended if that was unusual. */
function stepMeta(step) {
  const meta = [`${(step.tokens || 0).toLocaleString()} tokens`, `${((step.ms || 0) / 1000).toFixed(1)} s`];
  if (step.attempt) meta.unshift(`try ${step.attempt}, reasoning effort ${step.effort}`);
  const again = step.retryEffort ? `; asked again with reasoning effort ${step.retryEffort}` : '';
  if (step.stuck === 'loop') meta.push('stopped because the reasoning was going round in circles' + again);
  else if (step.stuck === 'budget') meta.push('the whole token budget went on reasoning' + again);
  else if (step.looped) meta.push('stopped because the model was repeating itself');
  else if (step.finish === 'length') meta.push('cut off at the length limit');
  return meta;
}

/**
 * The collapsed "View thinking trace" box at the foot of a page: what the model reasoned
 * before writing each part. Nothing is shown for a model that does not emit reasoning.
 * The text can run to hundreds of thousands of characters, so it is only laid out when opened.
 */
function showTrace(el, rec) {
  if (!el) return;
  const steps = (rec.log || []).filter(step => stepThinking(step));
  if (!steps.length) { el.innerHTML = ''; return; }
  const chars = steps.reduce((sum, step) => sum + stepThinking(step).length, 0);
  el.innerHTML = '<details class="trace"><summary>View thinking trace <span>' +
    `${escText(rec.model || 'the model')} reasoning its way to this page · ${steps.length} request${steps.length === 1 ? '' : 's'} · ` +
    `${chars.toLocaleString()} characters</span></summary><div class="trace-body"></div></details>`;
  const box = el.firstChild, body = box.lastChild;
  box.addEventListener('toggle', () => {
    if (!box.open || body.childNodes.length) return;
    body.innerHTML = '<p class="small muted">The model\'s own reasoning before it wrote each part, exactly as it arrived. ' +
      `The prompts and raw replies are under <a href="${escAttr(titlePath(rec.title))}?action=source">View source</a>.</p>` +
      steps.map(step => `<details class="source-step"><summary>${escText(step.step)} <span>${stepMeta(step).join(' · ')}</span></summary>` +
        `<div class="msg think"><pre>${escText(stepThinking(step))}</pre></div></details>`).join('');
  });
}

function showSource(rec) {
  const isCat = rec.type === 'category';
  chrome({ title: rec.title, ns: isCat ? 'Category' : 'Article', actions: true, action: 'source', footer: pageFooter(rec) });
  state.current = { type: 'source', title: rec.title };
  const msg = (cls, role, text) => `<div class="msg ${cls}"><div class="role">${role}</div><pre>${escText(text)}</pre></div>`;
  let html = '<p>These are the exact requests WikiLLM sent to <b>' + escText(rec.model) + '</b> to build this page, and the raw text it sent back.</p>';
  html += `<details class="source-step"><summary>System prompt <span>sent with every request</span></summary>${msg('', 'System', rec.system || '')}</details>`;
  (rec.log || []).forEach((step, i) => {
    html += `<details class="source-step"${step.retryEffort ? '' : ' open'}><summary>${i + 1}. ${escText(step.step)} <span>${stepMeta(step).join(' · ')}</span></summary>` +
      msg('', 'Request', step.prompt) +
      (step.thinking ? msg('think', 'Model reasoning', step.thinking) : '') +
      msg('reply', 'Model reply', step.response || '(empty)') + '</details>';
  });
  $('#content').innerHTML = html;
}

// ------------------------------------------------------------------ special pages

function modelWarning() {
  return '<div class="mbox warn"><div class="body"><div class="title">No model has been chosen yet</div>' +
    '<div class="detail">WikiLLM needs to know which local model should write the articles.</div></div>' +
    '<a class="btn primary" href="/wiki/Special:Settings" style="line-height:28px;color:#fff">Open model settings</a></div>';
}

function showMain() {
  chrome({ title: 'Main Page', ns: 'Main Page', sub: '', hideHeading: true });
  state.current = { type: 'main', title: 'Main Page' };
  const cfg = state.config;
  if (!cfg.model) $('#notice').innerHTML = modelWarning();
  const articles = state.pages.filter(p => p.type === 'article');
  const recent = state.pages.slice(0, 12);
  $('#content').innerHTML = `
    <div class="mp-welcome">
      <h2>Welcome to WikiLLM,</h2>
      <p>the encyclopedia that ${cfg.model ? '<b>' + escText(cfg.model) + '</b>' : 'your local model'} writes as you read.<br>
        <span class="muted small">${articles.length.toLocaleString()} article${articles.length === 1 ? '' : 's'} generated so far</span></p>
      <form class="mp-search" id="mp-search" autocomplete="off">
        <input type="search" placeholder="Look something up, e.g. Rhinoceros" aria-label="Look something up" autofocus>
        <button class="btn primary" type="submit">Look up</button>
      </form>
    </div>
    <div class="mp-columns">
      <div class="mp-box green"><h2>Recently generated</h2><div class="inner">
        ${recent.length
          ? '<ul>' + recent.map(p => `<li>${link(p.title)} <span class="muted small">· ${escText(p.model)}</span></li>`).join('') + '</ul>' +
            '<p class="small">' + link('Special:AllPages', 'All generated pages') + '</p>'
          : '<p class="muted">Nothing yet. Look something up and the first article will appear here.</p>'}
      </div></div>
      <div class="mp-box blue"><h2>Try looking up</h2><div class="inner">
        <ul>${SAMPLE_TOPICS.map(t => '<li>' + link(t) + '</li>').join('')}</ul>
      </div></div>
      <div class="mp-box purple"><h2>How it works</h2><div class="inner">
        <p>Nothing here is looked up. When you open a page that does not exist yet, WikiLLM asks the model for an outline,
        then an introduction, an infobox, each section in turn, related articles and categories, and lays the answers out as an
        encyclopedia article. Every link leads to another page written the same way, so you can wander through what the model
        believes about the world. Finished pages are kept in the <code>cache</code> folder; use <i>Regenerate</i> on any page to ask again,
        <i>View thinking trace</i> at the foot of an article to read how a reasoning model talked itself into what it wrote,
        and <i>View source</i> to read the exact prompts and raw replies.</p>
      </div></div>
    </div>`;
  $('#mp-search').addEventListener('submit', e => {
    e.preventDefault();
    lookUp($('input', e.target).value);
  });
}

function showAllPages() {
  chrome({ title: 'All pages', ns: 'Special page', sub: '' });
  state.current = { type: 'special', title: 'Special:AllPages' };
  const articles = state.pages.filter(p => p.type === 'article').map(p => p.title);
  const cats = state.pages.filter(p => p.type === 'category').map(p => p.title);
  const filed = new Map();
  state.pages.forEach(p => (p.categories || []).forEach(c => filed.set(c.toLowerCase(), c)));
  cats.forEach(c => filed.set(c.slice(9).toLowerCase(), c.slice(9)));
  let html = `<p>WikiLLM has generated ${articles.length} article${articles.length === 1 ? '' : 's'} so far.</p>`;
  html += '<h2>Articles</h2>' + (articles.length ? alphaColumns(articles, t => link(t)) : '<p class="empty">No articles yet.</p>');
  if (filed.size) {
    html += '<h2>Categories</h2>' + alphaColumns(Array.from(filed.values()), t => link('Category:' + t, t));
  }
  $('#content').innerHTML = html;
}

function showNoModel(title) {
  chrome({ title, ns: /^Category:/.test(title) ? 'Category' : 'Article' });
  state.current = { type: 'special', title };
  $('#notice').innerHTML = modelWarning();
  $('#content').innerHTML = '<p class="empty">This page has not been generated yet.</p>';
}

function showSettings() {
  chrome({ title: 'Model settings', ns: 'Special page', sub: '' });
  state.current = { type: 'special', title: 'Special:Settings' };
  const c = state.config;
  $('#content').innerHTML = `
  <form class="settings" id="settings" autocomplete="off">
    <p>WikiLLM talks to any server that offers an OpenAI-compatible API, such as LM Studio, Ollama, llama.cpp or vLLM. It is meant for a server on this computer or your own network.</p>
    <fieldset><legend>Connection</legend>
      <div class="field">
        <label for="f-base">API base URL</label>
        <div class="help">The address of your model server, usually ending in <code>/v1</code>.</div>
        <div class="row"><input type="text" id="f-base" value="${escAttr(c.baseUrl)}" spellcheck="false">
          <button type="button" class="btn" id="b-test">Connect</button></div>
        <div class="presets">
          <button type="button" class="btn" data-url="http://localhost:1234/v1">LM Studio</button>
          <button type="button" class="btn" data-url="http://localhost:11434/v1">Ollama</button>
          <button type="button" class="btn" data-url="http://localhost:8080/v1">llama.cpp</button>
          <button type="button" class="btn" data-url="http://localhost:8000/v1">vLLM</button>
          <button type="button" class="btn" data-url="http://localhost:1337/v1">Jan</button>
          <button type="button" class="btn" id="b-detect">Find running servers</button>
        </div>
        <div class="status" id="s-conn"></div>
      </div>
      <div class="field">
        <label for="f-key">API key <span class="muted" style="font-weight:normal">(optional)</span></label>
        <div class="help">Most local servers do not need one.</div>
        <input type="password" id="f-key" value="${escAttr(c.apiKey)}">
      </div>
      <div class="field">
        <label for="f-model">Model</label>
        <div class="help">The model that writes the articles.</div>
        <select id="f-model"></select>
        <input type="text" id="f-model-other" placeholder="Model name" spellcheck="false" style="margin-top:6px" hidden>
      </div>
    </fieldset>
    <fieldset><legend>Writing</legend>
      <div class="row2">
        <div class="field">
          <label for="f-length">Article length</label>
          <div class="help">Longer articles take more requests.</div>
          <select id="f-length">
            <option value="short">Short (3–4 brief sections)</option>
            <option value="standard">Standard (4–6 sections)</option>
            <option value="long">Long (6–9 detailed sections)</option>
          </select>
        </div>
        <div class="field">
          <label for="f-temp">Temperature</label>
          <div class="help">Lower is steadier, higher is more inventive.</div>
          <input type="number" id="f-temp" min="0" max="2" step="0.05" value="${escAttr(c.temperature)}">
        </div>
      </div>
      <div class="field">
        <label for="f-reasoning">Reasoning effort</label>
        <div class="help">For reasoning models whose server understands <code>reasoning_effort</code>; others ignore it. More reasoning is slower and usually gives richer, better linked text. Whatever is chosen here, a request that gets stuck in its reasoning is stopped and asked again one level lower.</div>
        <select id="f-reasoning">
          <option value="">Model default</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>
      <div class="field">
        <label for="f-parallel">Requests at once</label>
        <div class="help">How many of a page's requests are sent at the same time (1 to 6). Sections do not depend on each other, so a model server that can run requests in parallel finishes a page much sooner. A server that takes one request at a time just queues them, and 1 writes the page strictly top to bottom.</div>
        <input type="number" id="f-parallel" min="1" max="6" step="1" value="${escAttr(c.parallel || 6)}">
      </div>
      <div class="field">
        <label for="f-max">Max tokens per request</label>
        <div class="help">The upper limit for each of the requests that make up a page (reasoning included), not for the page as a whole. Set it as high as your model allows; replies normally stop on their own well before it.</div>
        <input type="number" id="f-max" min="64" max="1000000" step="1" value="${escAttr(c.maxTokens)}">
      </div>
      <div class="field">
        <label for="f-extra">Extra instructions</label>
        <div class="help">Added to the system prompt of every request, for example a writing style, a language, or a switch such as <code>/no_think</code>.</div>
        <textarea id="f-extra">${escText(c.extraInstructions)}</textarea>
      </div>
      <div class="field inline">
        <input type="checkbox" id="f-illus" ${c.illustrations ? 'checked' : ''}>
        <label for="f-illus"><b>Ask the model to draw an illustration</b><br>
          <span class="help">Experimental. Adds one more request per article asking for an SVG drawing for the infobox. Small models tend to produce abstract art.</span></label>
      </div>
    </fieldset>
    <div class="actions">
      <button type="submit" class="btn primary">Save settings</button>
      <span class="status" id="s-save" style="margin:0"></span>
    </div>
    <fieldset><legend>Generated pages</legend>
      <p class="small" style="margin:.4em 0 .8em">${state.pages.length} generated page${state.pages.length === 1 ? ' is' : 's are'} stored in the <code>cache</code> folder next to <code>server.py</code>.</p>
      <button type="button" class="btn danger" id="b-clear" ${state.pages.length ? '' : 'disabled'}>Delete all generated pages</button>
    </fieldset>
  </form>`;

  const form = $('#settings'), sel = $('#f-model'), other = $('#f-model-other'), conn = $('#s-conn');
  $('#f-length').value = c.length;
  $('#f-reasoning').value = c.reasoning || '';

  const setModels = (models, chosen) => {
    const list = models.slice();
    if (chosen && !list.includes(chosen)) list.unshift(chosen);
    sel.innerHTML = (list.length ? '' : '<option value="">(no models found)</option>') +
      list.map(m => `<option value="${escAttr(m)}">${escText(m)}</option>`).join('') +
      '<option value="__other">Other (type a name)…</option>';
    sel.value = chosen || (list[0] || '');
    other.hidden = sel.value !== '__other';
  };
  const chosenModel = () => (sel.value === '__other' ? other.value.trim() : sel.value);
  const say = (el, cls, text) => { el.className = 'status ' + cls; el.textContent = text; };
  sel.addEventListener('change', () => { other.hidden = sel.value !== '__other'; if (!other.hidden) other.focus(); });
  setModels([], c.model);

  const connect = async () => {
    say(conn, '', 'Connecting…');
    const keep = chosenModel();
    let r;
    try {
      r = await api('POST', '/api/test', { baseUrl: $('#f-base').value.trim(), apiKey: $('#f-key').value });
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    if (!form.isConnected) return false;
    if (r.ok) {
      r.models = r.models.filter(m => !/embed/i.test(m));   // embedding models cannot write
      setModels(r.models, keep && (r.models.includes(keep) || keep === c.model) ? keep : '');
      say(conn, 'ok', `Connected. ${r.models.length} model${r.models.length === 1 ? '' : 's'} available.`);
    } else {
      say(conn, 'bad', r.error || 'Could not connect.');
    }
    return r.ok;
  };
  const detect = async () => {
    say(conn, '', 'Looking for model servers on this computer…');
    const { servers } = await api('GET', '/api/detect');
    if (!form.isConnected) return;
    if (!servers.length) {
      say(conn, 'bad', 'No model server found on the usual ports. Start LM Studio, Ollama, llama.cpp or vLLM, or enter the address by hand.');
      return;
    }
    $('#f-base').value = servers[0].baseUrl;
    await connect();
    say(conn, 'ok', 'Found ' + servers.map(s => `${s.name} (${s.models.length} model${s.models.length === 1 ? '' : 's'})`).join(', ') + '.');
  };

  $('#b-test').addEventListener('click', connect);
  $('#b-detect').addEventListener('click', detect);
  $$('.presets [data-url]', form).forEach(b => b.addEventListener('click', () => { $('#f-base').value = b.dataset.url; connect(); }));
  $('#f-base').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); connect(); } });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      state.config = await api('POST', '/api/config', {
        baseUrl: $('#f-base').value.trim(), apiKey: $('#f-key').value, model: chosenModel(),
        length: $('#f-length').value, temperature: $('#f-temp').value, maxTokens: $('#f-max').value,
        extraInstructions: $('#f-extra').value, illustrations: $('#f-illus').checked, parallel: $('#f-parallel').value,
        reasoning: $('#f-reasoning').value,
      });
      say($('#s-save'), state.config.model ? 'ok' : 'bad',
        state.config.model ? `Saved. Articles will be written by ${state.config.model}.` : 'Saved, but no model is selected yet.');
    } catch (err) {
      say($('#s-save'), 'bad', 'Could not save: ' + err.message);
    }
  });

  $('#b-clear').addEventListener('click', async () => {
    if (!confirm(`Delete all ${state.pages.length} generated pages? This cannot be undone.`)) return;
    await api('DELETE', '/api/pages');
    await refreshPages();
    showSettings();
  });

  // Connect straight away; on a first visit with nothing working, go looking.
  connect().then(ok => { if (!ok && !c.model && form.isConnected) detect(); });
}

// ------------------------------------------------------------------ routing

let lastUrl = null, routeSeq = 0;

async function route(fromHistory) {
  const seq = ++routeSeq;
  lastUrl = location.pathname + location.search;
  cancelRun();
  const title = pathTitle();
  const action = new URLSearchParams(location.search).get('action');
  const from = state.from;
  state.from = null;
  hideSuggest();
  if (!fromHistory) window.scrollTo(0, 0);

  if (title === 'Main Page') return showMain();
  if (/^Special:/.test(title)) {
    const name = title.slice(8).toLowerCase();
    if (name === 'settings') return showSettings();
    if (name === 'allpages') return showAllPages();
    if (name === 'random') {
      const articles = state.pages.filter(p => p.type === 'article');
      const pick = articles.length ? articles[Math.floor(Math.random() * articles.length)].title : 'Main Page';
      return go(titlePath(pick), true);
    }
    chrome({ title, ns: 'Special page', sub: '' });
    $('#content').innerHTML = '<p class="empty">There is no such special page.</p>';
    return;
  }

  const existing = await getPage(title);
  if (seq !== routeSeq) return;
  const isCat = /^Category:/.test(title);

  if (action === 'delete') {
    if (existing && confirm(`Delete the generated page “${existing.title}”?`)) {
      await api('DELETE', '/api/page?title=' + encodeURIComponent(title));
      await refreshPages();
      return go('/wiki/Main_Page', true);
    }
    return go(titlePath(title), true);
  }
  if (action === 'regenerate') {
    history.replaceState(null, '', titlePath(title));
    lastUrl = location.pathname + location.search;
  } else if (existing) {
    if (action === 'source') return showSource(existing);
    return isCat ? showCategory(existing) : showArticle(existing);
  }
  if (!state.config.model) return showNoModel(title);
  return isCat ? generateCategory(title) : generateArticle(title, from || (existing && existing.from) || '');
}

function go(url, replace) {
  if (url === lastUrl && state.run && state.run.alive) return;   // already writing this page
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  return route();
}

function lookUp(query) {
  const title = normTitle(query);
  if (!title) return;
  const known = state.pages.find(p => sameTitle(p.title, title));
  go(titlePath(known ? known.title : title));
}

document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a');
  const href = a && a.getAttribute('href');
  if (!href) return;
  if (href.startsWith('#')) {
    e.preventDefault();
    const el = document.getElementById(href.slice(1));
    if (el) el.scrollIntoView(); else window.scrollTo(0, 0);
    return;
  }
  if (a.origin !== location.origin || !a.pathname.startsWith('/wiki/') || a.target) return;
  e.preventDefault();
  if (a.closest('#content') && state.current && state.current.type === 'article') state.from = state.current.title;
  go(a.pathname + a.search);
});

window.addEventListener('popstate', () => {
  if (location.pathname + location.search !== lastUrl) route(true);
});

// ------------------------------------------------------------------ search box

const searchInput = $('#search-input'), suggestBox = $('#search-suggest');
let suggestIndex = -1;

function hideSuggest() { suggestBox.hidden = true; suggestIndex = -1; }

function showSuggest() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return hideSuggest();
  const titles = state.pages.map(p => p.title);
  const hits = titles.filter(t => t.toLowerCase().startsWith(q))
    .concat(titles.filter(t => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q))).slice(0, 7);
  suggestBox.innerHTML = hits.map(t => `<li data-title="${escAttr(t)}">${escText(t)}</li>`).join('') +
    `<li class="search-for" data-title="${escAttr(searchInput.value.trim())}">Generate a page for <b>${escText(searchInput.value.trim())}</b></li>`;
  suggestIndex = -1;
  suggestBox.hidden = false;
}

searchInput.addEventListener('input', showSuggest);
searchInput.addEventListener('focus', showSuggest);
searchInput.addEventListener('blur', () => setTimeout(hideSuggest, 150));
searchInput.addEventListener('keydown', e => {
  const items = $$('li', suggestBox);
  if (e.key === 'Escape') return hideSuggest();
  if (suggestBox.hidden || !items.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  e.preventDefault();
  suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length + 1) % (items.length + 1);
  items.forEach((li, i) => li.classList.toggle('active', i === suggestIndex));
});
suggestBox.addEventListener('mousedown', e => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  searchInput.value = '';
  searchInput.blur();
  lookUp(li.dataset.title);
});
$('#search-form').addEventListener('submit', e => {
  e.preventDefault();
  const active = $('li.active', suggestBox);
  const q = active ? active.dataset.title : searchInput.value;
  searchInput.value = '';
  searchInput.blur();
  lookUp(q);
});

// ------------------------------------------------------------------ start

(async function init() {
  try {
    state.config = await api('GET', '/api/config');
    await refreshPages();
  } catch (err) {
    $('#content').innerHTML = '<div class="mbox error"><div class="body"><div class="title">Could not reach the WikiLLM server</div>' +
      '<div class="detail">Start it with <code>python3 server.py</code> and reload this page.</div></div></div>';
    return;
  }
  route(true);
})();
