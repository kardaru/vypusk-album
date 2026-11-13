import { readTags } from './id3.74651b06a0.js';
import { Spectrum } from './visualizer.74651b06a0.js';

// одна звуковая шина на весь альбом: она нужна только для спектра
let sharedCtx = null;
function ensureContext() {
  if (!sharedCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sharedCtx = new Ctx();
  }
  return sharedCtx;
}

const $ = (id) => document.getElementById(id);
const json = (url) => fetch(url, { cache: 'no-cache' }).then((r) => r.json());
const mmss = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
const hex = (n) => `0x${String(n).padStart(2, '0')}`;

const audio = $('audio');
const state = { album: null, tracks: [], i: 0, entered: false, tags: new Map(), viz: null, token: 0 };

/* ---------- печатная машинка на title screen ---------- */
function type(element, text, speed = 26) {
  return new Promise((done) => {
    let n = 0;
    const step = () => {
      element.textContent = text.slice(0, ++n);
      if (n < text.length) setTimeout(step, speed);
      else done();
    };
    step();
  });
}

/* ширина текста честным замером: у блока с nowrap scrollWidth врёт,
   поэтому мёрим detached-клоном с той же типографикой */
function textWidth(node, text, size) {
  const probe = node.cloneNode(false);
  probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:${size}px`;
  probe.textContent = text;
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w;
}

/* кегль заголовка: считаем только от ширины окна, коробка .boot-inner ей же
   и ограничена — иначе замер контейнера в разных браузерах разъезжается */
function fit(node, text) {
  const avail = innerWidth * 0.9;
  const w100 = textWidth(node, text, 100) || 1;
  node.style.fontSize = `${Math.min((avail / w100) * 100, innerHeight * 0.26, 170)}px`;
}

/* ---------- аудиорайвер альбома ---------- */
function connect() {
  if (state.analyser) return state.analyser;
  const ctx = ensureContext();
  // Пока контекст не запущен, маршрут через него сделал бы трек немым.
  // В этом случае оставляем прямой вывод и подключим спектр позже.
  if (ctx.state !== 'running') {
    ctx.resume().catch(() => {});
    return null;
  }
  const source = ctx.createMediaElementSource(audio);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.82;
  source.connect(analyser);
  analyser.connect(ctx.destination);
  state.analyser = analyser;
  state.ctx = ctx;
  state.viz = new Spectrum($('spectrum'), analyser);
  return analyser;
}

/* ---------- обложка из ID3 ---------- */
async function coverOf(track) {
  const cached = state.tags.get(track.file);
  if (cached) return cached;
  let tags = null;
  let ok = false;
  try {
    tags = await readTags(track.file);
    ok = true;
  } catch (err) {
    console.warn('ID3 не прочитан:', track.file, err);
  }
  if (!ok) return {}; // сетевой сбой не кэшируем: попробуем ещё раз
  const result = tags || {};
  state.tags.set(track.file, result);
  return result;
}

function paintCover(tags) {
  const box = $('cover');
  const img = box.querySelector('img');
  const missing = $('coverMissing');
  missing.hidden = Boolean(tags.picture);
  if (!tags.picture) {
    if (img) img.remove();
    return;
  }
  if (img) img.src = tags.picture.url;
  else {
    const node = document.createElement('img');
    node.alt = '';
    node.src = tags.picture.url;
    box.prepend(node);
  }
}

/* Обложки всех треков вычитываем из файлов заранее: к моменту переключения
   картинка уже в памяти и меняется синхронно, без ожидания сети. */
async function prefetchCovers() {
  const queue = state.tracks.slice();
  const worker = async () => {
    while (queue.length) {
      const track = queue.shift();
      const tags = await coverOf(track).catch(() => null);
      if (tags?.picture) {
        const warm = new Image();
        warm.src = tags.picture.url;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

/* ---------- выбор трека ---------- */
async function select(index, autoplay = true) {
  const track = state.tracks.at(index);
  if (!track) return;
  const token = ++state.token;
  state.i = index;
  audio.src = track.file;
  audio.load();

  $('trackNo').textContent = hex(track.no ?? index + 1);
  $('trackTitle').textContent = track.title || '';
  $('trackArtist').textContent = track.artist || '';
  $('trackNote').textContent = track.note || '';
  $('sideTag').textContent = track.sideName || '';
  document.querySelectorAll('.rail-row').forEach((row) =>
    row.classList.toggle('current', Number(row.dataset.i) === index));
  localStorage.setItem('vypusk.track', String(index));
  history.replaceState(null, '', `?t=${index}`);

  // старт — синхронно из обработчика жеста: iOS не даёт запускать звук
  // в отложенной задаче, а чтение обложки асинхронное
  if (autoplay) play();

  const known = state.tags.get(track.file);
  if (known) {
    // уже вычитано заранее — картинка меняется в тот же кадр, что и трек
    paintCover(known);
    syncMedia(track, known);
    return;
  }

  paintCover({ picture: null }); // чужую обложку не показываем ни кадра
  const tags = await coverOf(track);
  if (token !== state.token) return; // тем временем выбрали другой трек
  paintCover(tags);
  syncMedia(track, tags);
}

/* обложка, теги и замок экрана — всё вместе */
function syncMedia(track, tags) {
  if (!track.title && tags.title) $('trackTitle').textContent = tags.title;
  if (!track.artist && tags.artist) $('trackArtist').textContent = tags.artist;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: tags.title || track.title || 'без названия',
      artist: tags.artist || track.artist || '',
      album: state.album?.title || '',
      artwork: tags.picture ? [{ src: tags.picture.url, sizes: '512x512', type: tags.picture.mime }] : undefined,
    });
  }
}
async function play() {
  if (state.ctx?.state === 'suspended') state.ctx.resume().catch(() => {});
  try {
    await audio.play();
  } catch (err) {
    console.warn('трек не стартовал:', err);
  }
  if (audio.paused) return;
  $('btnPlay').innerHTML = '&#10074;&#10074;';
  $('btnPlay').setAttribute('aria-label', 'Пауза');
  // Спектр подключаем только после того, как звук реально пошёл: маршрут через
  // приостановленный AudioContext сам по себе делает трек немым.
  try {
    if (connect()) state.viz?.start();
  } catch (err) {
    console.warn('спектр недоступен, звук идёт напрямую:', err);
  }
}

function pause() {
  audio.pause();
  $('btnPlay').innerHTML = '&#9658;';
  $('btnPlay').setAttribute('aria-label', 'Играть');
  state.viz?.stop();
  state.viz?.idle();
}

const toggle = () => (audio.paused ? play() : pause());

/* ---------- дыхание обложки на басу ---------- */
function breathe() {
  requestAnimationFrame(breathe);
  if (!state.viz) return;
  $('cover').style.setProperty('--breathe', (1 + state.viz.bass * 0.022).toFixed(4));
  $('cover').style.setProperty('--glow', `${Math.round(state.viz.bass * 90)}px`);
  $('spectrum').style.opacity = audio.paused ? 0 : 1;
}

/* ---------- список ---------- */
function buildRail() {
  const rail = $('rail');
  rail.textContent = '';
  const h = document.createElement('h3');
  h.textContent = 'TRACKLIST';
  rail.append(h);

  const sides = [];
  state.tracks.forEach((t) => {
    let side = sides.find((s) => s.name === t.sideName);
    if (!side) sides.push({ name: t.sideName, note: t.sideNote, tracks: [t] });
    else side.tracks.push(t);
  });

  for (const side of sides) {
    const group = document.createElement('div');
    group.className = 'rail-group';
    const title = document.createElement('p');
    title.textContent = side.note ? `${side.name} [${side.note}]` : side.name;
    group.append(title);

    side.tracks.forEach((t) => {
      const i = state.tracks.indexOf(t);
      const row = document.createElement('button');
      row.className = 'rail-row';
      row.dataset.i = i;
      const no = document.createElement('span');
      no.className = 'n';
      no.textContent = hex(t.no ?? i + 1);
      const name = document.createElement('span');
      name.textContent = t.title || 'без названия';
      const dur = document.createElement('span');
      dur.className = 'd';
      dur.textContent = mmss(t.duration);
      row.append(no, name, dur);
      row.onclick = () => { select(i); closeRail(); };
      group.append(row);
    });
    rail.append(group);
  }

  const close = document.createElement('button');
  close.className = 'rail-close';
  close.textContent = '[ ЗАКРЫТЬ ]';
  close.onclick = closeRail;
  rail.append(close);
}

const openRail = () => $('rail').classList.add('open');
const closeRail = () => $('rail').classList.remove('open');

/* ---------- титры ---------- */
function showCredits() {
  const box = $('creditsScroll');
  box.textContent = '';
  const blank = () => box.append(Object.assign(document.createElement('div'), { className: 'blank' }));
  blank();
  (state.album?.credits || []).forEach((line) => {
    const p = document.createElement('div');
    p.textContent = line;
    box.append(p);
  });
  state.tracks.forEach((t) => {
    const line = document.createElement('div');
    const em = document.createElement('em');
    em.textContent = t.title || '';
    line.append(em, document.createTextNode(` · ${t.artist || ''}`));
    box.append(line);
  });
  blank();
  $('credits').hidden = false;
}

const hideCredits = () => ($('credits').hidden = true);

/* ---------- перемотка ---------- */
function seekFromEvent(ev) {
  const rect = $('seek').getBoundingClientRect();
  const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
  const ratio = Math.min(1, Math.max(0, x / rect.width));
  if (Number.isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
  $('seekFilled').style.width = `${ratio * 100}%`;
}

/* ---------- вход в альбом ---------- */
async function enter() {
  // resume строго в обработчике жеста: на iOS отложенный вызов не считается жестом
  const ctx = ensureContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  if (state.entered) return;
  state.entered = true;
  $('boot').classList.add('out');
  $('album').hidden = false;
  setTimeout(() => $('boot')?.remove(), 900);
  await select(state.i);
}

/* ---------- старт ---------- */
async function boot() {
  const [album, tracklist] = await Promise.all([json('album.74651b06a0.json'), json('tracks.74651b06a0.json')]);
  state.album = album;
  state.tracks = tracklist.sides.flatMap((side) =>
    side.tracks.map((t) => ({ ...t, sideName: side.name, sideNote: side.note })));

  document.title = album.title;
  $('bootFile').textContent = album.file || album.title;
  $('bootRel').textContent = album.release || '';
  // заглушки в квадратных скобках на экран не выводим: недописанный текст
  // лучше не показать вовсе, чем показать как есть
  const quote = String(album.epigraph || '').trim();
  $('bootQuote').textContent = quote.startsWith('[') ? '' : quote;
  $('bootQuote').hidden = !$('bootQuote').textContent;
  const greets = String(album.greetings || '').trim();
  const showGreets = greets && !greets.startsWith('[');
  $('bootGreetings').textContent = showGreets ? `${greets} ··· ${greets}` : '';
  document.querySelector('.scroller').hidden = !showGreets;
  $('bootHint').textContent = album.hint || 'press any key';
  $('bootGreetings').textContent = `${album.greetings} ··· ${album.greetings}`;
  $('bootMade').textContent = `сделано в петербурге · ${new Date().getFullYear()} · music disk`;
  $('mastFile').textContent = album.file || album.title;
  buildRail();

  const link = new URLSearchParams(location.search).get('t');
  const wanted = Number(link ?? localStorage.getItem('vypusk.track'));
  state.i = Number.isInteger(wanted) && state.tracks[wanted] ? wanted : 0;

  window.__album = state;
  prefetchCovers();

  addEventListener('keydown', enter);
  addEventListener('pointerdown', enter);
  addEventListener('touchstart', enter, { passive: true });

  // ?shell — сразу показать альбом: снимки раскладки и отладка без жеста
  if (new URLSearchParams(location.search).has('shell')) enter();

  // без готового шрифта замер ширины врёт: пиксельный Handjet шире системного моноширинного
  await Promise.race([
    document.fonts.load('700 100px Handjet', album.title).catch(() => {}),
    new Promise((r) => setTimeout(r, 1200)),
  ]);
  fit($('bootTitle'), album.title);
  await type($('bootTitle'), album.title, 30);
  fit($('bootTitle'), album.title);
  addEventListener('resize', () => $('bootTitle') && fit($('bootTitle'), album.title));
}

/* ---------- органы управления ---------- */
$('btnPlay').onclick = toggle;
$('btnPrev').onclick = () => select((state.i - 1 + state.tracks.length) % state.tracks.length);
$('btnNext').onclick = () => select((state.i + 1) % state.tracks.length);
$('btnList').onclick = openRail;
$('btnCredits').onclick = showCredits;
$('creditsClose').onclick = hideCredits;
$('seek').addEventListener('pointerdown', (e) => { seekFromEvent(e); e.currentTarget.setPointerCapture(e.pointerId); });
$('seek').addEventListener('pointermove', (e) => { if (e.buttons) seekFromEvent(e); });

audio.addEventListener('timeupdate', () => {
  const d = audio.duration || 0;
  $('seekFilled').style.width = `${d ? (audio.currentTime / d) * 100 : 0}%`;
  $('seekTime').textContent = `${mmss(audio.currentTime)} / ${mmss(d)}`;
});
audio.addEventListener('ended', () => {
  if (state.i + 1 < state.tracks.length) select(state.i + 1);
  else { pause(); showCredits(); }
});

addEventListener('keydown', (e) => {
  if (!state.entered) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); toggle(); }
  else if (k === 'arrowright') select(Math.min(state.i + 1, state.tracks.length - 1));
  else if (k === 'arrowleft') select(Math.max(state.i - 1, 0));
  else if (k === 'c') $('credits').hidden ? showCredits() : hideCredits();
  else if (k === 'l') $('rail').classList.toggle('open');
  else if (k === 'escape') { closeRail(); hideCredits(); }
  else if (/^[1-9]$/.test(k)) select(Math.min(Number(k) - 1, state.tracks.length - 1));
});

let touchX = 0;
addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
addEventListener('touchend', (e) => {
  if (!state.entered) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 70) select(Math.min(Math.max(state.i + (dx < 0 ? 1 : -1), 0), state.tracks.length - 1));
}, { passive: true });

addEventListener('offline', () => ($('offlineBadge').hidden = false));
addEventListener('online', () => ($('offlineBadge').hidden = true));

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  // приехала новая версия — сразу перезагружаемся, иначе человек остаётся
  // на старой сборке из кэша и видит уже исправленный баг
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'offline-ready') $('offlineBadge').textContent = 'работает офлайн';
  });
}

$('buildTag').textContent = `v ${document.querySelector('meta[name=build]')?.content || 'dev'}`;

breathe();
boot();
