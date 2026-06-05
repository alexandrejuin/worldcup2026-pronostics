// ============================================================
// Robot de récupération des résultats — Coupe du Monde 2026
// Lancé par GitHub Actions. Récupère les résultats sur
// football-data.org, les mappe à la structure du site, et les
// écrit dans Firestore (doc players/official_results).
// ============================================================

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const ADMIN_CODE = process.env.ADMIN_CODE || null;

// Identifiants Firebase (publics par conception — déjà dans le HTML du site)
const PROJECT_ID = 'world-cup-2026-dcaf3';
const WEB_API_KEY = 'AIzaSyCOQoM5tfu4sXE40ZxLlTLk6lxdCVOqksA';
const OFFICIAL_DOC = 'official_results';

// --- Composition des groupes (mêmes noms FR que le site) ---
const GROUPS_DATA = {
  A: ['Mexique', 'Afrique du Sud', 'Corée du Sud', 'Tchéquie'],
  B: ['Canada', 'Suisse', 'Qatar', 'Bosnie-Herzégovine'],
  C: ['Brésil', 'Maroc', 'Écosse', 'Haïti'],
  D: ['États-Unis', 'Australie', 'Paraguay', 'Turquie'],
  E: ['Allemagne', 'Curaçao', "Côte d'Ivoire", 'Équateur'],
  F: ['Pays-Bas', 'Japon', 'Suède', 'Tunisie'],
  G: ['Belgique', 'Égypte', 'Iran', 'Nouvelle-Zélande'],
  H: ['Espagne', 'Cap-Vert', 'Arabie Saoudite', 'Uruguay'],
  I: ['France', 'Sénégal', 'Irak', 'Norvège'],
  J: ['Argentine', 'Autriche', 'Algérie', 'Jordanie'],
  K: ['Portugal', 'Colombie', 'Ouzbékistan', 'RD Congo'],
  L: ['Angleterre', 'Croatie', 'Panama', 'Ghana'],
};

// --- Mapping noms anglais (football-data.org) -> noms FR ---
// Clé = forme normalisée (minuscule, sans accents/ponctuation).
const RAW_MAP = {
  'Mexico': 'Mexique', 'South Africa': 'Afrique du Sud',
  'Korea Republic': 'Corée du Sud', 'South Korea': 'Corée du Sud',
  'Czechia': 'Tchéquie', 'Czech Republic': 'Tchéquie',
  'Canada': 'Canada', 'Switzerland': 'Suisse', 'Qatar': 'Qatar',
  'Bosnia and Herzegovina': 'Bosnie-Herzégovine', 'Bosnia-Herzegovina': 'Bosnie-Herzégovine',
  'Brazil': 'Brésil', 'Morocco': 'Maroc', 'Scotland': 'Écosse', 'Haiti': 'Haïti',
  'United States': 'États-Unis', 'USA': 'États-Unis',
  'Australia': 'Australie', 'Paraguay': 'Paraguay',
  'Turkey': 'Turquie', 'Türkiye': 'Turquie', 'Turkiye': 'Turquie',
  'Germany': 'Allemagne', 'Curacao': 'Curaçao', 'Curaçao': 'Curaçao',
  'Ivory Coast': "Côte d'Ivoire", "Cote d'Ivoire": "Côte d'Ivoire", "Côte d'Ivoire": "Côte d'Ivoire",
  'Ecuador': 'Équateur',
  'Netherlands': 'Pays-Bas', 'Japan': 'Japon', 'Sweden': 'Suède', 'Tunisia': 'Tunisie',
  'Belgium': 'Belgique', 'Egypt': 'Égypte', 'Iran': 'Iran', 'IR Iran': 'Iran',
  'New Zealand': 'Nouvelle-Zélande',
  'Spain': 'Espagne', 'Cape Verde': 'Cap-Vert', 'Cabo Verde': 'Cap-Vert',
  'Saudi Arabia': 'Arabie Saoudite', 'Uruguay': 'Uruguay',
  'France': 'France', 'Senegal': 'Sénégal', 'Iraq': 'Irak', 'Norway': 'Norvège',
  'Argentina': 'Argentine', 'Austria': 'Autriche', 'Algeria': 'Algérie', 'Jordan': 'Jordanie',
  'Portugal': 'Portugal', 'Colombia': 'Colombie', 'Uzbekistan': 'Ouzbékistan',
  'DR Congo': 'RD Congo', 'Congo DR': 'RD Congo', 'Democratic Republic of Congo': 'RD Congo',
  'Congo': 'RD Congo',
  'England': 'Angleterre', 'Croatia': 'Croatie', 'Panama': 'Panama', 'Ghana': 'Ghana',
};
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const TEAM_MAP = {};
Object.entries(RAW_MAP).forEach(([en, fr]) => { TEAM_MAP[norm(en)] = fr; });
// Tolérance : les noms FR doivent aussi se reconnaître eux-mêmes
Object.values(GROUPS_DATA).flat().forEach(fr => { TEAM_MAP[norm(fr)] = fr; });

const unmapped = new Set();
function mapTeam(name) {
  const fr = TEAM_MAP[norm(name)];
  if (!fr) unmapped.add(name);
  return fr || null;
}

// --- Ordre des matchs d'un groupe (identique à genMatches du site) ---
function groupMatchIndex(teamsFr, a, b) {
  let idx = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const ti = teamsFr[i], tj = teamsFr[j];
    if ((ti === a && tj === b) || (ti === b && tj === a)) return { idx, home: ti, away: tj };
    idx++;
  }
  return null;
}

// --- Transformation : matchs API -> payload officiel ---
function buildOfficialPayload(matches) {
  // Groupes : init 6 matchs vides par groupe
  const groups = {};
  Object.keys(GROUPS_DATA).forEach(g => { groups[g] = { matches: Array.from({ length: 6 }, () => ({ result: null, score: null })) }; });

  const reachedQF = new Set(), reachedSF = new Set(), reachedFinal = new Set();
  let champion = null;

  for (const m of matches) {
    if (m.status !== 'FINISHED') continue;
    const ft = m.score && m.score.fullTime ? m.score.fullTime : {};
    const homeFr = mapTeam(m.homeTeam && m.homeTeam.name);
    const awayFr = mapTeam(m.awayTeam && m.awayTeam.name);
    if (!homeFr || !awayFr) continue;
    const stage = m.stage || '';

    if (stage === 'GROUP_STAGE') {
      const g = (m.group || '').replace('GROUP_', '').trim().toUpperCase();
      if (!GROUPS_DATA[g]) continue;
      const pos = groupMatchIndex(GROUPS_DATA[g], homeFr, awayFr);
      if (!pos) continue;
      // Réorienter le score dans l'ordre du site (home = pos.home)
      let sH, sA;
      if (m.homeTeam && mapTeam(m.homeTeam.name) === pos.home) { sH = ft.home; sA = ft.away; }
      else { sH = ft.away; sA = ft.home; }
      if (sH == null || sA == null) continue;
      const result = sH > sA ? 'home' : sA > sH ? 'away' : 'draw';
      groups[g].matches[pos.idx] = { result, score: [sH, sA] };
    } else if (stage === 'QUARTER_FINALS') {
      reachedQF.add(homeFr); reachedQF.add(awayFr);
    } else if (stage === 'SEMI_FINALS') {
      reachedSF.add(homeFr); reachedSF.add(awayFr);
    } else if (stage === 'FINAL') {
      reachedFinal.add(homeFr); reachedFinal.add(awayFr);
      const w = m.score && m.score.winner;
      if (w === 'HOME_TEAM') champion = homeFr;
      else if (w === 'AWAY_TEAM') champion = awayFr;
      else if (ft.home != null && ft.away != null && ft.home !== ft.away) champion = ft.home > ft.away ? homeFr : awayFr;
    }
  }

  const officialKO = {
    reachedQF: [...reachedQF], reachedSF: [...reachedSF],
    reachedFinal: [...reachedFinal], champion,
  };
  return { groups, officialKO };
}

// --- Conversion en valeurs typées Firestore REST ---
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') {
    const fields = {};
    Object.entries(v).forEach(([k, val]) => { fields[k] = toFs(val); });
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

async function writeOfficial(payload) {
  const fields = {
    groups: toFs(payload.groups),
    officialKO: toFs(payload.officialKO),
    isOfficial: toFs(true),
    name: toFs('__OFFICIEL__'),
    updatedAt: { timestampValue: new Date().toISOString() },
  };
  if (ADMIN_CODE) fields.code = toFs(ADMIN_CODE);

  const mask = ['groups', 'officialKO', 'isOfficial', 'name', 'updatedAt']
    .concat(ADMIN_CODE ? ['code'] : [])
    .map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/players/${OFFICIAL_DOC}?${mask}&key=${WEB_API_KEY}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Écriture Firestore échouée (${res.status}): ${txt}`);
  }
}

async function main() {
  if (!FOOTBALL_DATA_TOKEN) {
    console.log('⏭️  FOOTBALL_DATA_TOKEN absent — rien à faire (configure le secret GitHub).');
    return;
  }
  console.log('📡 Récupération des matchs sur football-data.org…');
  const res = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API football-data échouée (${res.status}): ${txt}`);
  }
  const data = await res.json();
  const matches = data.matches || [];
  const finished = matches.filter(m => m.status === 'FINISHED');
  console.log(`   ${matches.length} matchs reçus, ${finished.length} terminés.`);

  const payload = buildOfficialPayload(matches);

  if (unmapped.size) {
    console.warn('⚠️  Équipes non mappées (à ajouter dans RAW_MAP) :', [...unmapped]);
  }

  const nbGroupResults = Object.values(payload.groups).reduce((n, g) => n + g.matches.filter(m => m.result).length, 0);
  console.log(`   Résultats de poules : ${nbGroupResults}/72`);
  console.log(`   Quarts: ${payload.officialKO.reachedQF.length} équipes · Demies: ${payload.officialKO.reachedSF.length} · Finale: ${payload.officialKO.reachedFinal.length} · Champion: ${payload.officialKO.champion || '—'}`);

  await writeOfficial(payload);
  console.log('✅ Résultats officiels écrits dans Firestore.');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
