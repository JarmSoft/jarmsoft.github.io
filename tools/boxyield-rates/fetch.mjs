#!/usr/bin/env node
// BoxYield: descarga el último tipo de referencia overnight de cada divisa con
// una fuente oficial gratuita y sin clave, y escribe boxyield/rates.json.
//
// - Node 20+, sin dependencias (usa fetch global).
// - Valores en porcentaje anual.
// - Si una fuente falla se conserva el valor anterior del rates.json (con su
//   fecha antigua); nunca se escribe null encima de un valor bueno.
// - `--dry-run` imprime el resultado por pantalla y no escribe nada.
// - Código de salida: 0 si al menos una fuente funcionó; 1 solo si fallan todas.
//
// Uso: node tools/boxyield-rates/fetch.mjs [--dry-run] [--out ruta/rates.json]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 20_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outIdx = args.indexOf('--out');
const outPath = resolve(
  outIdx >= 0 ? args[outIdx + 1] : resolve(here, '../../boxyield/rates.json'),
);

// ── Utilidades ───────────────────────────────────────────────────────────

async function get(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: '*/*', ...(init.headers ?? {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const getText = async (url, init) => (await get(url, init)).text();
const getJson = async (url, init) => (await get(url, init)).json();

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
  'Oct', 'Nov', 'Dec'];

/** Parte una línea CSV respetando comillas. */
function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const csvRows = (text, sep = ',') =>
  text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '')
    .map((l) => splitCsvLine(l, sep));

/** Primer valor `<tag ...>contenido</tag>` de un XML sencillo. */
const xmlTag = (xml, tag) =>
  new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml)?.[1]?.trim();

function num(v) {
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw new Error(`valor no numérico: ${v}`);
  return n;
}

const round = (n, d = 4) => Number(n.toFixed(d));

// ── Fuentes ──────────────────────────────────────────────────────────────
// Cada fuente devuelve { name, value (%), date (AAAA-MM-DD), source, url }.
// El campo `url` debe ser estable (sin fechas): si cambiara cada día, el archivo
// cambiaría cada día aunque el tipo no se moviera.

const sources = {
  // Estados Unidos: SOFR (Fed de Nueva York)
  async USD() {
    const url = 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json';
    const r = (await getJson(url)).refRates[0];
    return { name: 'SOFR', value: num(r.percentRate), date: r.effectiveDate,
      source: 'NY Fed', url };
  },

  // Zona euro: €STR (BCE)
  async EUR() {
    const url = 'https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2QQF16.CR' +
      '?format=jsondata&lastNObservations=1&detail=dataonly';
    const j = await getJson(url);
    const series = Object.values(j.dataSets[0].series)[0];
    const keys = Object.keys(series.observations);
    const k = keys.reduce((a, b) => (Number(a) > Number(b) ? a : b));
    const value = num(series.observations[k][0]);
    const date = j.structure.dimensions.observation[0].values[Number(k)].id;
    return { name: '€STR', value, date, source: 'ECB', url };
  },

  // Reino Unido: SONIA (Banco de Inglaterra, CSV)
  async GBP() {
    const from = daysAgo(35);
    const to = new Date();
    const f = (d) => `${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}`;
    const url = 'https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp' +
      `?csv.x=yes&Datefrom=${f(from)}&Dateto=${f(to)}&SeriesCodes=IUDSOIA` +
      '&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N';
    const rows = csvRows(await getText(url)).filter((r) => /^\d{1,2} \w{3} \d{4}$/.test(r[0]));
    if (!rows.length) throw new Error('sin filas');
    const [d, mon, y] = rows.at(-1)[0].split(' ');
    const m = MONTHS.indexOf(mon) + 1;
    return { name: 'SONIA', value: num(rows.at(-1)[1]), date: `${y}-${pad(m)}-${pad(d)}`,
      source: 'Bank of England',
      url: 'https://www.bankofengland.co.uk/markets/sonia-benchmark' };
  },

  // Suiza: SARON (Banco Nacional Suizo, CSV)
  async CHF() {
    const url = `https://data.snb.ch/api/cube/snbgwdzid/data/csv/en?fromDate=${isoDay(daysAgo(20))}`;
    const rows = csvRows(await getText(url), ';').filter((r) => r[1] === 'SARON' && /^\d{4}-/.test(r[0]));
    if (!rows.length) throw new Error('sin filas SARON');
    const last = rows.reduce((a, b) => (a[0] >= b[0] ? a : b));
    return { name: 'SARON', value: num(last[2]), date: last[0], source: 'SNB',
      url: 'https://data.snb.ch/en/topics/snb/cube/snbgwdzid' };
  },

  // Canadá: CORRA (Banco de Canadá)
  async CAD() {
    const url = 'https://www.bankofcanada.ca/valet/observations/AVG.INTWO/json?recent=1';
    const o = (await getJson(url)).observations[0];
    return { name: 'CORRA', value: num(o['AVG.INTWO'].v), date: o.d,
      source: 'Bank of Canada', url };
  },

  // Brasil: Selic diaria (BCB SGS 11, tasa DIARIA) anualizada a 252 días hábiles
  async BRL() {
    const url = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/1?formato=json';
    const o = (await getJson(url))[0];
    const daily = num(o.valor);
    const annual = (Math.pow(1 + daily / 100, 252) - 1) * 100;
    const [d, m, y] = o.data.split('/');
    return { name: 'Selic', value: round(annual, 2), date: `${y}-${m}-${d}`,
      source: 'Banco Central do Brasil', url };
  },

  // Japón: TONA, tipo overnight sin garantía (Banco de Japón, CSV)
  async JPY() {
    const start = daysAgo(45);
    const url = 'https://www.stat-search.boj.or.jp/api/v1/getDataCode?format=csv&lang=en' +
      `&db=FM01&code=STRDCLUCON&startDate=${start.getUTCFullYear()}${pad(start.getUTCMonth() + 1)}`;
    const rows = csvRows(await getText(url)).filter((r) => /^\d{8}$/.test(r.at(-2) ?? '') && r.at(-1) !== 'null');
    if (!rows.length) throw new Error('sin filas');
    const last = rows.reduce((a, b) => (a.at(-2) >= b.at(-2) ? a : b));
    const d = last.at(-2);
    return { name: 'TONA', value: num(last.at(-1)), date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`,
      source: 'Bank of Japan',
      url: 'https://www.stat-search.boj.or.jp/index_en.html' };
  },

  // Hong Kong: HIBOR overnight (HKMA)
  async HKD() {
    const url = 'https://api.hkma.gov.hk/public/market-data-and-statistics/daily-monetary-statistics/daily-figures-interbank-liquidity?pagesize=1';
    const r = (await getJson(url)).result.records[0];
    return { name: 'HIBOR O/N', value: num(r.hibor_overnight), date: r.end_of_date,
      source: 'HKMA', url };
  },

  // Israel: SHIR (Banco de Israel, SDMX CSV)
  async ILS() {
    const url = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/BR/1.0/?format=csv&lastNObservations=1';
    const rows = csvRows(await getText(url));
    const head = rows[0];
    const iCode = head.indexOf('SERIES_CODE');
    const iDate = head.indexOf('TIME_PERIOD');
    const iVal = head.indexOf('OBS_VALUE');
    const r = rows.find((x) => x[iCode] === 'MNT_SHIR_D');
    if (!r) throw new Error('sin serie SHIR');
    return { name: 'SHIR', value: num(r[iVal]), date: r[iDate], source: 'Bank of Israel', url };
  },

  // Argentina: repo a 1 día entre terceros (BCRA v4.0, serie 150)
  async ARS() {
    const url = 'https://api.bcra.gob.ar/estadisticas/v4.0/monetarias/150?limit=1';
    const d = (await getJson(url)).results[0].detalle[0];
    return { name: 'Repo 1d', value: num(d.valor), date: d.fecha, source: 'BCRA', url };
  },

  // Polonia: tipo de referencia del NBP (solo cambia en cada decisión)
  async PLN() {
    const url = 'https://static.nbp.pl/dane/stopy/stopy_procentowe.xml';
    const xml = await getText(url);
    // Bloque <pozycja id="ref" ... /> (los atributos pueden venir en cualquier orden).
    const block = /<pozycja\b[^>]*?\bid\s*=\s*"ref"[^>]*?\/>/.exec(xml)?.[0];
    if (!block) throw new Error('sin tipo de referencia');
    const attr = (n) => new RegExp(`\\b${n}\\s*=\\s*"([^"]+)"`).exec(block)?.[1];
    const value = attr('oprocentowanie');
    if (!value) throw new Error('sin oprocentowanie');
    // Fecha desde la que rige el tipo (no la de hoy: solo cambia en cada decisión).
    return { name: 'NBP ref.', value: num(value), date: attr('obowiazuje_od') ?? '',
      source: 'NBP', url };
  },

  // Rusia: RUONIA (Banco Central de Rusia, SOAP sin clave)
  async RUB() {
    const url = 'https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx';
    const body = '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
      `<Ruonia xmlns="http://web.cbr.ru/"><fromDate>${isoDay(daysAgo(30))}</fromDate>` +
      `<ToDate>${isoDay(new Date())}</ToDate></Ruonia></soap:Body></soap:Envelope>`;
    const xml = await getText(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://web.cbr.ru/Ruonia"' },
      body,
    });
    const items = [...xml.matchAll(/<ro(?:\s[^>]*)?>([\s\S]*?)<\/ro>/g)].map((m) => ({
      date: xmlTag(m[1], 'D0')?.slice(0, 10),
      value: xmlTag(m[1], 'ruo'),
    })).filter((x) => x.date && x.value);
    if (!items.length) throw new Error('sin filas RUONIA');
    const last = items.reduce((a, b) => (a.date >= b.date ? a : b));
    return { name: 'RUONIA', value: num(last.value), date: last.date,
      source: 'Bank of Russia', url };
  },
};

// ── Validación y combinación ─────────────────────────────────────────────

function validate(r) {
  if (!(r.value > -5 && r.value < 200)) throw new Error(`valor fuera de rango: ${r.value}`);
  if (!/^\d{4}-\d{2}-\d{2}/.test(r.date ?? '')) throw new Error(`fecha no válida: ${r.date}`);
  r.date = r.date.slice(0, 10);
  r.value = round(r.value, 4);
  return r;
}

async function readPrevious() {
  try {
    const j = JSON.parse(await readFile(outPath, 'utf8'));
    return j && typeof j === 'object' && j.rates && typeof j.rates === 'object' ? j : null;
  } catch {
    return null;
  }
}

const previous = await readPrevious();
const rates = {};
const failed = [];
let fresh = 0;

await Promise.all(Object.entries(sources).map(async ([ccy, fn]) => {
  try {
    rates[ccy] = validate(await fn());
    fresh++;
    console.error(`OK    ${ccy}  ${rates[ccy].name} ${rates[ccy].value} (${rates[ccy].date})`);
  } catch (e) {
    const old = previous?.rates?.[ccy];
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    failed.push(ccy);
    console.error(`FALLO ${ccy}  ${e?.message ?? e}${cause ? ` [${cause}]` : ''}` +
      (old ? `  -> se conserva ${old.value} (${old.date})` : '  -> sin valor previo'));
    if (old) rates[ccy] = old;
  }
}));

// Divisas que ya no tienen fuente pero estaban en el archivo anterior: se
// conservan tal cual (no se pierde nada por quitar una fuente del script).
for (const [ccy, old] of Object.entries(previous?.rates ?? {})) {
  if (!(ccy in rates)) rates[ccy] = old;
}

const sorted = Object.fromEntries(Object.entries(rates).sort(([a], [b]) => a.localeCompare(b)));

// `updatedAt` solo cambia si cambia algún tipo; así el flujo de trabajo no
// genera un commit diario cuando nada se ha movido.
const same = previous && JSON.stringify(previous.rates) === JSON.stringify(sorted);
const out = {
  schema: 1,
  updatedAt: same && previous.updatedAt ? previous.updatedAt : new Date().toISOString(),
  rates: sorted,
};
const text = `${JSON.stringify(out, null, 2)}\n`;

if (dryRun) {
  console.log(text);
  console.error(`(dry-run: no se escribe nada) fuentes OK: ${fresh}, con fallo: ${failed.length}`);
} else if (fresh === 0) {
  console.error('Todas las fuentes han fallado: no se escribe nada.');
} else if (same) {
  console.error('Sin cambios: rates.json queda como estaba.');
} else {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text, 'utf8');
  console.error(`Escrito ${outPath}`);
}

process.exit(fresh === 0 ? 1 : 0);    const block = /<pozycja[^>]*?id="ref"[^>]*?/>/.exec(xml)?.[0];
    if (!block) throw new Error('sin tipo de referencia');
    const attr = (n) => new RegExp().exec(block)?.[1];
    const value = attr('oprocentowanie');
    if (!value) throw new Error('sin oprocentowanie');
    return { name: 'NBP ref.', value: num(value), date: attr('obowiazuje_od') ?? '',
      source: 'NBP', url };
  },

  // Rusia: RUONIA (Banco Central de Rusia, SOAP sin clave)
  async RUB() {
    const url = 'https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx';
    const body = '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
      `<Ruonia xmlns="http://web.cbr.ru/"><fromDate>${isoDay(daysAgo(30))}</fromDate>` +
      `<ToDate>${isoDay(new Date())}</ToDate></Ruonia></soap:Body></soap:Envelope>`;
    const xml = await getText(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://web.cbr.ru/Ruonia"' },
      body,
    });
    const items = [...xml.matchAll(/<ro(?:\s[^>]*)?>([\s\S]*?)<\/ro>/g)].map((m) => ({
      date: xmlTag(m[1], 'D0')?.slice(0, 10),
      value: xmlTag(m[1], 'ruo'),
    })).filter((x) => x.date && x.value);
    if (!items.length) throw new Error('sin filas RUONIA');
    const last = items.reduce((a, b) => (a.date >= b.date ? a : b));
    return { name: 'RUONIA', value: num(last.value), date: last.date,
      source: 'Bank of Russia', url };
  },
};

// ── Validación y combinación ─────────────────────────────────────────────

function validate(r) {
  if (!(r.value > -5 && r.value < 200)) throw new Error(`valor fuera de rango: ${r.value}`);
  if (!/^\d{4}-\d{2}-\d{2}/.test(r.date ?? '')) throw new Error(`fecha no válida: ${r.date}`);
  r.date = r.date.slice(0, 10);
  r.value = round(r.value, 4);
  return r;
}

async function readPrevious() {
  try {
    const j = JSON.parse(await readFile(outPath, 'utf8'));
    return j && typeof j === 'object' && j.rates && typeof j.rates === 'object' ? j : null;
  } catch {
    return null;
  }
}

const previous = await readPrevious();
const rates = {};
const failed = [];
let fresh = 0;

await Promise.all(Object.entries(sources).map(async ([ccy, fn]) => {
  try {
    rates[ccy] = validate(await fn());
    fresh++;
    console.error(`OK    ${ccy}  ${rates[ccy].name} ${rates[ccy].value} (${rates[ccy].date})`);
  } catch (e) {
    const old = previous?.rates?.[ccy];
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    failed.push(ccy);
    console.error(`FALLO ${ccy}  ${e?.message ?? e}${cause ? ` [${cause}]` : ''}` +
      (old ? `  -> se conserva ${old.value} (${old.date})` : '  -> sin valor previo'));
    if (old) rates[ccy] = old;
  }
}));

// Divisas que ya no tienen fuente pero estaban en el archivo anterior: se
// conservan tal cual (no se pierde nada por quitar una fuente del script).
for (const [ccy, old] of Object.entries(previous?.rates ?? {})) {
  if (!(ccy in rates)) rates[ccy] = old;
}

const sorted = Object.fromEntries(Object.entries(rates).sort(([a], [b]) => a.localeCompare(b)));

// `updatedAt` solo cambia si cambia algún tipo; así el flujo de trabajo no
// genera un commit diario cuando nada se ha movido.
const same = previous && JSON.stringify(previous.rates) === JSON.stringify(sorted);
const out = {
  schema: 1,
  updatedAt: same && previous.updatedAt ? previous.updatedAt : new Date().toISOString(),
  rates: sorted,
};
const text = `${JSON.stringify(out, null, 2)}\n`;

if (dryRun) {
  console.log(text);
  console.error(`(dry-run: no se escribe nada) fuentes OK: ${fresh}, con fallo: ${failed.length}`);
} else if (fresh === 0) {
  console.error('Todas las fuentes han fallado: no se escribe nada.');
} else if (same) {
  console.error('Sin cambios: rates.json queda como estaba.');
} else {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text, 'utf8');
  console.error(`Escrito ${outPath}`);
}

process.exit(fresh === 0 ? 1 : 0);
