// scripts/fetch-mma.js
//
// Recupera automaticamente eventi e atleti MMA/UFC dalle API pubbliche di ESPN
// e aggiorna data/events.json e data/fighters.json.
//
// Pensato per girare ogni giorno via GitHub Actions (.github/workflows/update-data.yml).
//
// REGOLA CHIAVE: non deve mai fallire in silenzio. Ogni errore viene loggato
// in modo leggibile nel log dell'Action (Actions tab -> run -> step "Esegui script").
// Se qualcosa nella struttura dati ESPN cambia, questo è il primo posto da guardare.

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const EVENTS_PATH = path.join(ROOT, "data", "events.json");
const FIGHTERS_PATH = path.join(ROOT, "data", "fighters.json");

const DAYS_BACK = 3;   // quanti giorni indietro controllare (per catturare risultati recenti)
const DAYS_FORWARD = 60; // quanti giorni avanti controllare (prossimi eventi)
const REQUEST_DELAY_MS = 150; // pausa tra una chiamata e l'altra, per educazione verso l'API gratuita

function log(msg) {
  console.log(`[fetch-mma] ${msg}`);
}
function warn(msg) {
  console.warn(`[fetch-mma][ATTENZIONE] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    warn(`Impossibile leggere ${p} (${e.message}), uso un valore vuoto di partenza.`);
    return fallback;
  }
}

function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 0));
}

// Normalizza un nome in chiave coerente con il seed esistente (tutto minuscolo, spazi puliti)
function nameKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Converte una data ISO (es. "1989-09-20") nel formato DD/MM/YYYY usato dal motore numerologico esistente
function isoToDDMMYYYY(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "combat-oracle-fetch-script/1.0 (uso personale, non commerciale)" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} per ${url}`);
  }
  return res.json();
}

// Prova a recuperare la data di nascita di un atleta dal suo profilo ESPN.
// Lo schema esatto di questo endpoint non è stato verificato in modo live:
// se non trova il campo atteso, lo segnala chiaramente invece di fallire in silenzio.
async function tryFetchAthleteDob(espnAthleteId) {
  if (!espnAthleteId) return null;
  const url = `https://site.api.espn.com/apis/common/v3/sports/mma/ufc/athletes/${espnAthleteId}`;
  try {
    const data = await fetchJson(url);
    const candidate =
      data?.athlete?.dateOfBirth ||
      data?.athlete?.birthDate ||
      data?.dateOfBirth ||
      null;
    if (!candidate) {
      warn(`Nessuna data di nascita trovata per athlete id ${espnAthleteId} nella risposta di ${url}. Campi disponibili: ${Object.keys(data?.athlete || data || {}).join(", ")}`);
      return null;
    }
    return isoToDDMMYYYY(candidate);
  } catch (e) {
    warn(`Fetch profilo atleta ${espnAthleteId} fallito: ${e.message}`);
    return null;
  }
}

async function main() {
  log("Avvio recupero dati MMA/UFC da ESPN...");

  const events = loadJson(EVENTS_PATH, { events: {} });
  if (!events.events) events.events = {};
  const fighters = loadJson(FIGHTERS_PATH, {});

  const today = new Date();
  const dates = [];
  for (let i = -DAYS_BACK; i <= DAYS_FORWARD; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(yyyymmdd(d));
  }

  let eventsFound = 0;
  let eventsUpdated = 0;
  let fightersAdded = 0;
  let fightersNeedingDob = 0;
  let errors = 0;

  for (const dateStr of dates) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=${dateStr}`;
    try {
      const data = await fetchJson(url);
      const evList = Array.isArray(data.events) ? data.events : [];

      if (evList.length > 0) {
        log(`${dateStr}: trovati ${evList.length} evento/i.`);
      }

      for (const ev of evList) {
        eventsFound++;
        const evId = ev.id;
        const evName = ev.name || ev.shortName || `Evento ${evId}`;
        const evDate = ev.date || null;
        const competitions = Array.isArray(ev.competitions) ? ev.competitions : [];

        const fights = [];
        for (const comp of competitions) {
          const competitors = Array.isArray(comp.competitors) ? comp.competitors : [];
          const fightFighters = [];

          for (const c of competitors) {
            const athlete = c.athlete || {};
            const fullName = athlete.displayName || athlete.fullName || athlete.shortName || null;
            if (!fullName) {
              warn(`Competitor senza nome leggibile nell'evento ${evId} (athlete id: ${athlete.id || "sconosciuto"}). Salto.`);
              continue;
            }
            const key = nameKey(fullName);
            fightFighters.push(key);

            if (!fighters[key]) {
              fighters[key] = {
                dob: null,
                source: "espn",
                espnId: athlete.id || null,
                displayName: fullName,
                needsDob: true,
              };
              fightersAdded++;
              fightersNeedingDob++;
              // Nota: il recupero della DOB per nuovi atleti è intenzionalmente lasciato
              // alla fase successiva (vedi commento in fondo al file) per non rallentare
              // o appesantire troppo questa prima passata.
            }
          }

          fights.push({
            fightId: comp.id || null,
            fighters: fightFighters,
            completed: !!comp.status?.type?.completed,
            winner:
              competitors.find((c) => c.winner)?.athlete?.displayName
                ? nameKey(competitors.find((c) => c.winner).athlete.displayName)
                : null,
            method: comp.status?.type?.description || null,
          });
        }

        const isNew = !events.events[evId];
        events.events[evId] = {
          id: evId,
          name: evName,
          date: evDate,
          fights,
          lastSeen: new Date().toISOString(),
        };
        if (!isNew) eventsUpdated++;
      }
    } catch (e) {
      errors++;
      warn(`Chiamata fallita per data ${dateStr}: ${e.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Seconda passata: prova a recuperare la data di nascita per i nuovi atleti trovati,
  // ma solo per un numero limitato a run per non appesantire troppo l'esecuzione giornaliera.
  const MAX_DOB_LOOKUPS_PER_RUN = 25;
  const needingDob = Object.entries(fighters)
    .filter(([, v]) => v.needsDob)
    .slice(0, MAX_DOB_LOOKUPS_PER_RUN);

  if (needingDob.length > 0) {
    log(`Provo a recuperare la data di nascita per ${needingDob.length} nuovo/i atleta/i (max ${MAX_DOB_LOOKUPS_PER_RUN} per run)...`);
  }

  for (const [key, v] of needingDob) {
    const dob = await tryFetchAthleteDob(v.espnId);
    if (dob) {
      fighters[key].dob = dob;
      fighters[key].needsDob = false;
      log(`DOB trovata per "${key}": ${dob}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  events._lastUpdated = new Date().toISOString();

  saveJson(EVENTS_PATH, events);
  saveJson(FIGHTERS_PATH, fighters);

  const stillMissingDob = Object.values(fighters).filter((v) => v.needsDob).length;

  log("── Riepilogo ──────────────────────────────");
  log(`Date controllate: ${dates.length} (da -${DAYS_BACK}gg a +${DAYS_FORWARD}gg)`);
  log(`Eventi totali trovati in questa finestra: ${eventsFound}`);
  log(`Eventi aggiornati (già noti): ${eventsUpdated}`);
  log(`Nuovi atleti aggiunti: ${fightersAdded}`);
  log(`Atleti ancora senza data di nascita: ${stillMissingDob} (verranno ritentati nei prossimi run, max ${MAX_DOB_LOOKUPS_PER_RUN}/giorno)`);
  log(`Chiamate fallite: ${errors}`);
  log(`Totale atleti nel database: ${Object.keys(fighters).length}`);
  log("────────────────────────────────────────────");

  if (errors === dates.length) {
    // Tutte le chiamate sono fallite: probabile problema di rete o endpoint cambiato.
    // Usciamo con errore così l'Action risulta rossa e visibile, invece di sembrare
    // andata a buon fine senza aver fatto nulla.
    console.error("[fetch-mma] Tutte le chiamate a ESPN sono fallite. Controlla il log sopra per il dettaglio.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[fetch-mma] Errore non gestito:", e);
  process.exit(1);
});
