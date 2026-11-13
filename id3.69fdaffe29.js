// Читаем ID3v2 прямо из mp3: обложка остаётся встроенной в файл,
// предварительной выгрузки картинок не нужно.
const latin = new TextDecoder('iso-8859-1');
const utf8 = new TextDecoder('utf-8');

function be(u8, off, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + u8[off + i];
  return v;
}

const synchsafe = (u8, off) =>
  ((u8[off] & 0x7f) * 0x200000) + ((u8[off + 1] & 0x7f) << 14) + ((u8[off + 2] & 0x7f) << 7) + (u8[off + 3] & 0x7f);

function decodeText(u8, enc) {
  if (enc === 1) return new TextDecoder(u8[0] === 0xff && u8[1] === 0xfe ? 'utf-16le' : 'utf-16be').decode(u8.subarray(2));
  if (enc === 2) return new TextDecoder('utf-16be').decode(u8);
  if (enc === 3) return utf8.decode(u8);
  return latin.decode(u8);
}

const clean = (s) => s.split('\0').join(' ').trim();

const afterTerminator = (u8, from, wide) => {
  let i = from;
  const step = wide ? 2 : 1;
  while (i + step - 1 < u8.length) {
    if (wide ? (u8[i] === 0 && u8[i + 1] === 0) : u8[i] === 0) return i + step;
    i += step;
  }
  return u8.length;
};

function unsynthesize(u8) {
  const out = new Uint8Array(u8.length);
  let n = 0;
  for (let i = 0; i < u8.length; i++) {
    out[n++] = u8[i];
    if (u8[i] === 0xff && u8[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

async function fetchHead(url, last) {
  const res = await fetch(url, { headers: { Range: `bytes=0-${last}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`id3: http ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function readPicture(v, isV22, out) {
  const enc = isV22 ? v[0] : v[0];
  let i = 1;
  let mime;
  if (isV22) {
    mime = 'image/' + latin.decode(v.subarray(1, 4)).toLowerCase();
    i = 4;
  } else {
    i = afterTerminator(v, 1, false);
    mime = latin.decode(v.subarray(1, i - 1)).trim() || 'image/jpeg';
  }
  const type = v[i];
  const descStart = i + 1;
  const dataStart = isV22
    ? afterTerminator(v, descStart, false)
    : afterTerminator(v, descStart, enc === 1 || enc === 2);
  // 3 = front cover, но берём любую, если фронтальной нет
  if (dataStart < v.length && v.length - dataStart > 512 && (!out.picture || type === 3)) {
    out.picture = { mime, bytes: v.slice(dataStart, v.length) };
  }
}

export async function readTags(url) {
  let buf = await fetchHead(url, 1023);
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;

  const major = buf[3];
  const flags = buf[5];
  // 'ID3' + version + revision + flags = 5 байт, размер тега (synchsafe) — байты 6..9
  const tagEnd = Math.min(10 + synchsafe(buf, 6), 8_000_000);
  if (buf.length < tagEnd) buf = await fetchHead(url, tagEnd - 1);

  let body = buf.subarray(10, tagEnd);
  if (flags & 0x80) body = unsynthesize(body);

  const idLen = major === 2 ? 3 : 4;
  const frameHead = major === 2 ? 6 : 10;
  let p = major >= 3 && (flags & 0x40) ? (major === 4 ? synchsafe(body, 0) : be(body, 0, 4) + 4) : 0;

  const out = { title: null, artist: null, album: null, track: null, picture: null };

  while (p + frameHead <= body.length) {
    const id = latin.decode(body.subarray(p, p + idLen));
    if (!/^[A-Z][A-Z0-9]+$/.test(id)) break;
    const size = major === 4 ? synchsafe(body, p + idLen) : be(body, p + idLen, idLen);
    const start = p + frameHead;
    if (size <= 0 || start + size > body.length) break;

    let v = body.subarray(start, start + size);
    // флаги кадра — байты p+8..p+9. В v2.4 unsynchronisation = 0x02 в первом байте,
    // а 0x01 означает 4-байтный data length indicator в начале значения.
    if (major === 4) {
      const fl = body[start - 2];
      if (fl & 0x02) v = unsynthesize(v);
      if (fl & 0x01) v = v.subarray(4);
    }

    if (id === 'TIT2' || id === 'TT2') out.title = clean(decodeText(v.subarray(1), v[0]));
    else if (id === 'TPE1' || id === 'TP1') out.artist = clean(decodeText(v.subarray(1), v[0]));
    else if (id === 'TALB' || id === 'TAL') out.album = clean(decodeText(v.subarray(1), v[0]));
    else if (id === 'TRCK' || id === 'TRK') out.track = clean(decodeText(v.subarray(1), v[0])).split('/')[0];
    else if (id === 'APIC' || id === 'PIC') readPicture(v, id === 'PIC', out);

    p = start + size;
  }

  if (out.picture) {
    out.picture.url = URL.createObjectURL(new Blob([out.picture.bytes], { type: out.picture.mime }));
    delete out.picture.bytes;
  }
  return Object.values(out).some((x) => x) ? out : null;
}
