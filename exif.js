'use strict';
// Reads the hidden camera data in a JPEG (EXIF, XMP, content credentials) and decides whether a
// photo looks like a recent, local photo from a real camera.
//
// This checks the file's metadata. It catches casual fakes: images labelled as AI-made, files saved
// by photo editors, screenshots and downloaded pictures (no camera data), old photos, and photos
// taken outside Chennai. It cannot prove a photo is genuine, because metadata can be rewritten with
// free tools. The coordinator still reviews photos.

// Programs that edit pictures. Camera apps do not write these names into the Software tag.
const EDITORS = [
  'photoshop', 'lightroom', 'gimp', 'snapseed', 'canva', 'picsart', 'facetune', 'pixlr', 'paint.net',
  'affinity', 'capture one', 'photopea', 'remini', 'meitu', 'vsco', 'polarr', 'photoroom', 'fotor', 'luminar'
];
// Image generators.
const AI_TOOLS = [
  'midjourney', 'dall-e', 'dalle', 'stable diffusion', 'firefly', 'gemini', 'imagen', 'openai', 'chatgpt',
  'generative', 'sora', 'leonardo', 'ideogram', 'dreamstudio', 'nano banana'
];

function readJpegSegments(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const segs = [];
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) break;
    const marker = buf[p + 1];
    if (marker === 0xff) { p++; continue; }                    // padding byte
    if (marker === 0xd9 || marker === 0xda) break;             // end of image / start of pixel data
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) break;
    segs.push({ marker, data: buf.subarray(p + 4, p + 2 + len) });
    p += 2 + len;
  }
  return segs;
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function parseTiff(t) {
  const out = { make: '', model: '', software: '', taken: '', lat: null, lon: null };
  if (t.length < 8) return out;
  const order = t.toString('latin1', 0, 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return out;
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return out;

  function readIfd(off) {
    const map = new Map();
    if (off < 8 || off + 2 > t.length) return map;
    const n = u16(off);
    for (let i = 0; i < n && i < 200; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = (TYPE_SIZE[type] || 0) * count;
      if (!size || size > 65535) continue;
      const vo = size <= 4 ? e + 8 : u32(e + 8);
      if (vo + size > t.length) continue;
      map.set(tag, { type, count, vo });
    }
    return map;
  }
  const str = (ent) => (ent && ent.type === 2
    ? t.toString('latin1', ent.vo, ent.vo + ent.count).replace(/\0[\s\S]*$/, '').trim() : '');
  const rat = (ent, i) => { const o = ent.vo + i * 8; const d = u32(o + 4); return d ? u32(o) / d : 0; };
  const ptr = (ent) => (ent && ent.type === 4 ? u32(ent.vo) : 0);

  const ifd0 = readIfd(u32(4));
  out.make = str(ifd0.get(0x010f));
  out.model = str(ifd0.get(0x0110));
  out.software = str(ifd0.get(0x0131));

  const exifOff = ptr(ifd0.get(0x8769));
  if (exifOff) {
    const ex = readIfd(exifOff);
    out.taken = str(ex.get(0x9003)) || str(ex.get(0x9004));
  }
  const gpsOff = ptr(ifd0.get(0x8825));
  if (gpsOff) {
    const g = readIfd(gpsOff);
    const la = g.get(2), lo = g.get(4);
    if (la && lo && la.type === 5 && la.count === 3 && lo.type === 5 && lo.count === 3) {
      let lat = rat(la, 0) + rat(la, 1) / 60 + rat(la, 2) / 3600;
      let lon = rat(lo, 0) + rat(lo, 1) / 60 + rat(lo, 2) / 3600;
      if (str(g.get(1)).toUpperCase() === 'S') lat = -lat;
      if (str(g.get(3)).toUpperCase() === 'W') lon = -lon;
      out.lat = lat; out.lon = lon;
    }
  }
  return out;
}

// Everything the portal needs from a JPEG's hidden data.
function inspectJpeg(buf) {
  const segs = readJpegSegments(buf);
  if (!segs) return null;
  const info = { make: '', model: '', software: '', taken: '', lat: null, lon: null, xmp: '', jumbf: '' };
  for (const s of segs) {
    if (s.marker === 0xe1 && s.data.toString('latin1', 0, 6) === 'Exif\0\0') {
      const x = parseTiff(s.data.subarray(6));
      for (const k of ['make', 'model', 'software', 'taken']) if (x[k] && !info[k]) info[k] = x[k];
      if (x.lat !== null && info.lat === null) { info.lat = x.lat; info.lon = x.lon; }
    } else if (s.marker === 0xe1 && s.data.toString('latin1', 0, 28).startsWith('http://ns.adobe.com/xap/1.0/')) {
      info.xmp += s.data.toString('utf8', 29);
    } else if (s.marker === 0xe1 && s.data.toString('latin1', 0, 34).startsWith('http://ns.adobe.com/xmp/extension/')) {
      info.xmp += s.data.toString('latin1', 35);
    } else if (s.marker === 0xeb) {                    // JUMBF boxes carry content credentials (C2PA)
      info.jumbf += s.data.toString('latin1');
    }
  }
  return info;
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Camera clocks store local time without a zone. Photos here are taken in India (UTC+05:30).
function takenToMs(stamp) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(stamp || '');
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 5.5 * 3600_000;
}

// Returns { status: 'verified' | 'unverified' | 'rejected', notes: [...], lat, lon, taken }.
//   rejected   - edited by a photo editor or labelled as AI-made: the photo is refused.
//   unverified - accepted, but it does not get the extra weight (missing or doubtful camera data).
//   verified   - camera details, a recent date, and a location inside the college's area.
function checkPhoto(buf, cfg, nowMs) {
  const info = inspectJpeg(buf);
  if (!info) return { status: 'rejected', notes: ['The file is not a valid JPEG photo'], lat: null, lon: null, taken: null };

  const creator = (/<xmp:CreatorTool>([^<]*)<\/xmp:CreatorTool>/.exec(info.xmp) || /xmp:CreatorTool="([^"]*)"/.exec(info.xmp) || [])[1] || '';
  const tools = `${info.software} ${creator}`.toLowerCase();
  const rejects = [];
  const editor = EDITORS.find((e) => tools.includes(e));
  if (editor) rejects.push(`It was saved by a photo editor (${editor})`);
  const ai = AI_TOOLS.find((a) => tools.includes(a));
  if (ai) rejects.push(`It was made with an image generator (${ai})`);
  if (/trainedalgorithmicmedia/i.test(info.xmp + info.jumbf)) rejects.push('Its content credentials label it as AI-generated');
  if (rejects.length) return { status: 'rejected', notes: rejects, lat: null, lon: null, taken: null };

  const notes = [];
  if (!info.make || !info.model) notes.push('No camera make or model in the photo');
  if (/<xmpMM:History>/.test(info.xmp) && /stEvt:action="(saved|derived|converted)"/.test(info.xmp)) notes.push('The file has an editing history');

  const takenMs = takenToMs(info.taken);
  if (takenMs === null) {
    notes.push('No date in the photo');
  } else {
    const ageH = (nowMs - takenMs) / 3600_000;
    if (ageH > cfg.maxAgeHours) notes.push(`Taken more than ${cfg.maxAgeHours} hours ago`);
    if (ageH < -0.25) notes.push('The date in the photo is in the future');
  }

  if (info.lat === null) {
    notes.push('No location in the photo. Turn on location for the camera app');
  } else if (distanceKm(info.lat, info.lon, cfg.centerLat, cfg.centerLon) > cfg.radiusKm) {
    notes.push('The photo location is outside the Chennai area');
  }

  return {
    status: notes.length ? 'unverified' : 'verified',
    notes,
    lat: info.lat === null ? null : Math.round(info.lat * 1e4) / 1e4,
    lon: info.lon === null ? null : Math.round(info.lon * 1e4) / 1e4,
    taken: takenMs === null ? null : new Date(takenMs).toISOString()
  };
}

module.exports = { checkPhoto, inspectJpeg, distanceKm };
