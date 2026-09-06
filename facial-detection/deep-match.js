'use strict';

function l2norm(vec) {
  if (!vec || !vec.length) return vec;
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  s = Math.sqrt(s);
  if (!s) return vec.slice();
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / s;
  return out;
}

function euclidean(a, b) {
  if (!a || !b) return Infinity;
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function cosineDistance(a, b) {
  const na = l2norm(a);
  const nb = l2norm(b);
  let dot = 0;
  for (let i = 0; i < 128; i++) dot += na[i] * nb[i];
  return 1 - dot;
}

function fusedDistance(a, b) {
  const na = l2norm(a);
  const nb = l2norm(b);
  const euc = euclidean(na, nb);
  let dot = 0;
  for (let i = 0; i < 128; i++) dot += na[i] * nb[i];
  const cos = 1 - dot;
  return 0.65 * euc + 0.35 * cos;
}

function descriptorsOfPerson(person) {
  const out = [];
  for (const photo of person.photos || []) {
    if (photo && photo.descriptor && photo.descriptor.length === 128) out.push(photo.descriptor);
  }
  return out;
}

function descriptorsOfUnknown(cluster) {
  const out = [];
  if (cluster.descriptor && cluster.descriptor.length === 128) out.push(cluster.descriptor);
  for (const img of cluster.images || []) {
    if (img && typeof img === 'object' && img.descriptor && img.descriptor.length === 128) {
      out.push(img.descriptor);
    }
  }
  return out;
}

function scoreGallery(probe, gallery) {
  const dists = [];
  for (const g of gallery) dists.push(fusedDistance(probe, g));
  if (!dists.length) return null;
  dists.sort((a, b) => a - b);
  const best = dists[0];
  const k = Math.min(3, dists.length);
  let meanTop = 0;
  for (let i = 0; i < k; i++) meanTop += dists[i];
  meanTop /= k;
  const median = dists[Math.floor((dists.length - 1) / 2)];
  return { best, meanTop, median, n: dists.length, dists };
}

function matchDeep(descriptor, people, config) {
  const cfg = config || {};
  const matchT = cfg.matchThreshold ?? 0.42;
  const uncertainT = cfg.uncertainThreshold ?? 0.48;
  const margin = Math.max(0.06, cfg.ambiguousDelta ?? 0.08);
  const probe = l2norm(descriptor);
  const ranked = [];
  for (const person of people || []) {
    const gallery = descriptorsOfPerson(person);
    const score = scoreGallery(probe, gallery);
    if (!score) continue;
    const agree = score.dists.filter((d) => d <= matchT).length;
    ranked.push({
      person,
      distance: score.best,
      best: score.best,
      meanTop: score.meanTop,
      median: score.median,
      agree,
      agreeFrac: agree / score.n,
      n: score.n
    });
  }
  ranked.sort((a, b) => a.meanTop - b.meanTop || a.best - b.best);
  if (!ranked.length) return { status: 'unknown', person: null, distance: null, second: null };

  const a = ranked[0];
  const b = ranked[1] || null;
  if (b && a.best < uncertainT && b.best - a.best < margin) {
    return {
      status: 'ambiguous',
      person: a.person,
      distance: a.best,
      second: { id: b.person.id, name: b.person.name, distance: b.best }
    };
  }

  const multiOk = a.n < 2 || a.agree >= 2 || a.agreeFrac >= 0.45 || a.meanTop <= matchT;
  const verified = a.best <= matchT && a.meanTop <= matchT + 0.035 && multiOk;
  if (verified) {
    return { status: 'known', person: a.person, distance: a.best, second: b ? { id: b.person.id, name: b.person.name, distance: b.best } : null };
  }
  if (a.best <= uncertainT && a.meanTop <= uncertainT + 0.03) {
    return { status: 'uncertain', person: a.person, distance: a.best, second: b ? { id: b.person.id, name: b.person.name, distance: b.best } : null };
  }
  return { status: 'unknown', person: a.person, distance: a.best, second: b ? { id: b.person.id, name: b.person.name, distance: b.best } : null };
}

function bestUnknownMatch(descriptor, unknowns) {
  let best = null;
  for (const cluster of unknowns || []) {
    const gallery = descriptorsOfUnknown(cluster);
    const score = scoreGallery(descriptor, gallery);
    if (!score) continue;
    if (!best || score.best < best.distance) best = { cluster, distance: score.best, meanTop: score.meanTop };
  }
  return best;
}

function minDistanceToGallery(descriptor, gallery) {
  let best = Infinity;
  for (const g of gallery) {
    const d = fusedDistance(descriptor, g);
    if (d < best) best = d;
  }
  return best;
}

function averageDescriptors(list) {
  const acc = new Array(128).fill(0);
  let count = 0;
  for (const d of list) {
    if (!d || d.length !== 128) continue;
    const n = l2norm(d);
    count += 1;
    for (let i = 0; i < 128; i++) acc[i] += n[i];
  }
  if (!count) return list[0] || null;
  for (let i = 0; i < 128; i++) acc[i] /= count;
  return l2norm(acc);
}

module.exports = {
  l2norm,
  euclidean,
  fusedDistance,
  matchDeep,
  bestUnknownMatch,
  descriptorsOfPerson,
  descriptorsOfUnknown,
  minDistanceToGallery,
  averageDescriptors
};
