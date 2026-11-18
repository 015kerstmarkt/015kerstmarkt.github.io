// 015Kerstmarkt uploadserver (Cloudflare Worker)
//
// Wat hij doet:
//   POST /upload            foto of filmpje van de app -> commit in de privé-repo (map fotos/)
//   POST /vinkjes           aantal vinkjes + naam per toestel -> database (voor de mutsenloting)
//   GET  /beheer/...        overzicht, fotolijst, foto ophalen, loting (alleen met de beheersleutel)
//
// Instellen in Cloudflare (Settings > Variables and Secrets / Bindings):
//   secret  GH_TOKEN     fine-grained GitHub-token, alleen "Contents: read and write" op de privé-repo
//   secret  BEHEER_KEY   zelfbedacht wachtwoord voor de beheerpagina
//   tekst   REPO         amarks-lang/015-app-prive
//   tekst   ORIGINS      https://amarks-lang.github.io
//   D1      DB           database (tabellen worden vanzelf aangemaakt)

const MAX_BASE64 = 46_000_000;   // ~33 MB origineel; GitHub staat tot 100 MB toe, maar we houden de repo klein
const PER_TOESTEL = 25;          // max uploads per telefoon
const VINKJES_NODIG = 7;
const EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
              mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/mp4" };

let klaar = false;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const toegestaan = (env.ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const originOk = !origin || toegestaan.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      "Access-Control-Allow-Origin": origin && originOk ? origin : (toegestaan[0] || "*"),
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Beheer",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (!klaar) { await maakTabellen(env); klaar = true; }
      const p = url.pathname;

      if (p === "/") return json({ ok: true, app: "015kerstmarkt" });

      if (p === "/upload" && req.method === "POST") {
        if (!originOk) return json({ fout: "Deze site mag niet uploaden." }, 403);
        return await upload(req, env, url, json);
      }

      if (p === "/vinkjes" && req.method === "POST") {
        if (!originOk) return json({ fout: "Deze site mag dit niet." }, 403);
        const b = await req.json();
        const id = schoonId(b.id);
        if (!id) return json({ fout: "Ongeldig toestel." }, 400);
        const n = Math.max(0, Math.min(50, b.vinkjes | 0));
        await env.DB.prepare(
          `INSERT INTO bezoekers (id, naam, vinkjes, bijgewerkt) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(id) DO UPDATE SET naam = ?2, vinkjes = ?3, bijgewerkt = ?4`
        ).bind(id, schoonNaam(b.naam), n, Date.now()).run();
        return json({ ok: true });
      }

      if (p.startsWith("/beheer/")) {
        const sleutel = req.headers.get("X-Beheer") || url.searchParams.get("key") || "";
        if (!env.BEHEER_KEY || sleutel !== env.BEHEER_KEY) return json({ fout: "Verkeerde beheersleutel." }, 401);
        return await beheer(p.slice(8), req, env, url, json, cors);
      }

      return json({ fout: "Niet gevonden." }, 404);
    } catch (e) {
      return json({ fout: "Serverfout: " + (e && e.message || e) }, 500);
    }
  },
};

async function maakTabellen(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bezoekers (
      id TEXT PRIMARY KEY, naam TEXT DEFAULT '', vinkjes INTEGER DEFAULT 0,
      winnaar INTEGER DEFAULT 0, bijgewerkt INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS uploads (
      pad TEXT PRIMARY KEY, id TEXT, naam TEXT, soort TEXT, bytes INTEGER,
      t INTEGER, verborgen INTEGER DEFAULT 0)`),
  ]);
}

const schoonId = s => (typeof s === "string" && /^[a-z0-9]{8,32}$/.test(s)) ? s : "";
const schoonNaam = s => String(s || "").replace(/[\u0000-\u001f<>"]/g, "").trim().slice(0, 30);
const slug = s => schoonNaam(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "anoniem";

async function upload(req, env, url, json) {
  const id = schoonId(url.searchParams.get("id"));
  const ext = (url.searchParams.get("ext") || "").toLowerCase();
  const naam = schoonNaam(url.searchParams.get("naam"));
  if (!id) return json({ fout: "Ongeldig toestel." }, 400);
  if (!EXT[ext]) return json({ fout: "Dit bestandstype kan niet." }, 415);
  const lengte = +(req.headers.get("Content-Length") || 0);
  if (lengte > MAX_BASE64) return json({ fout: "Bestand is te groot. Maak een korter filmpje." }, 413);

  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM uploads WHERE id = ?1").bind(id).first();
  if (n >= PER_TOESTEL) return json({ fout: `Je hebt al ${PER_TOESTEL} POV's verstuurd. Dank je!` }, 429);

  // De app stuurt het bestand al als base64-tekst, dus hier hoeft niets omgerekend te worden.
  const data = new Uint8Array(await req.arrayBuffer());
  if (!data.length || data.length > MAX_BASE64) return json({ fout: "Leeg of te groot bestand." }, 400);
  for (let i = 0; i < Math.min(64, data.length); i++) {
    const c = data[i];
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61;
    if (!ok) return json({ fout: "Bestand is niet goed aangekomen." }, 400);
  }

  const nu = new Date();
  const dag = nu.toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });               // 2026-12-12
  const tijd = nu.toLocaleTimeString("nl-NL", { timeZone: "Europe/Amsterdam", hour12: false }).replace(/:/g, "");
  const pad = `fotos/${dag}/${tijd}-${slug(naam)}-${crypto.randomUUID().slice(0, 6)}.${ext}`;
  const bericht = `POV van ${naam || "anoniem"}`;

  const enc = new TextEncoder();
  const voor = enc.encode(`{"message":${JSON.stringify(bericht)},"content":"`);
  const na = enc.encode(`"}`);
  const body = new Uint8Array(voor.length + data.length + na.length);
  body.set(voor, 0); body.set(data, voor.length); body.set(na, voor.length + data.length);

  // Meerdere uploads tegelijk kunnen op GitHub botsen (409); dan even wachten en opnieuw.
  let res, tekst = "";
  for (let poging = 0; poging < 5; poging++) {
    res = await fetch(`https://api.github.com/repos/${env.REPO}/contents/${pad}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "015kerstmarkt-worker",
        "Content-Type": "application/json",
      },
      body,
    });
    if (res.ok) break;
    tekst = await res.text();
    if (res.status !== 409 && res.status < 500) break;
    await new Promise(r => setTimeout(r, 300 + Math.random() * 900 * (poging + 1)));
  }
  if (!res.ok) return json({ fout: `Opslaan bij GitHub mislukte (${res.status}).`, details: tekst.slice(0, 300) }, 502);

  const soort = EXT[ext].startsWith("video") ? "video" : "image";
  await env.DB.prepare("INSERT INTO uploads (pad, id, naam, soort, bytes, t) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(pad, id, naam, soort, Math.round(data.length * 0.75), Date.now()).run();
  return json({ ok: true, pad });
}

async function beheer(actie, req, env, url, json, cors) {
  const DB = env.DB;

  if (actie === "overzicht") {
    const r = await DB.batch([
      DB.prepare("SELECT COUNT(*) AS n FROM bezoekers"),
      DB.prepare("SELECT COUNT(*) AS n FROM bezoekers WHERE vinkjes >= ?1").bind(VINKJES_NODIG),
      DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(soort = 'video'), 0) AS films FROM uploads WHERE verborgen = 0"),
      DB.prepare("SELECT COALESCE(SUM(vinkjes), 0) AS n FROM bezoekers"),
      DB.prepare("SELECT naam, substr(id, -4) AS lot, vinkjes FROM bezoekers WHERE winnaar = 1 ORDER BY bijgewerkt"),
    ]);
    return json({
      bezoekers: r[0].results[0].n, metGenoeg: r[1].results[0].n,
      uploads: r[2].results[0].n, filmpjes: r[2].results[0].films,
      vinkjes: r[3].results[0].n, winnaars: r[4].results, vinkjesNodig: VINKJES_NODIG,
    });
  }

  if (actie === "fotos") {
    const alles = url.searchParams.get("alles") === "1";
    const { results } = await DB.prepare(
      `SELECT pad, naam, soort, bytes, t, verborgen FROM uploads ${alles ? "" : "WHERE verborgen = 0"} ORDER BY t DESC LIMIT 500`
    ).all();
    return json({ fotos: results });
  }

  if (actie === "foto") {
    const pad = url.searchParams.get("pad") || "";
    if (!/^fotos\/[\w\-./]+$/.test(pad) || pad.includes("..")) return json({ fout: "Ongeldig pad." }, 400);
    const res = await fetch(`https://api.github.com/repos/${env.REPO}/contents/${pad}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github.raw+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "015kerstmarkt-worker" },
    });
    if (!res.ok) return json({ fout: `Niet gevonden (${res.status}).` }, res.status);
    const ext = pad.split(".").pop().toLowerCase();
    const h = { ...cors, "Content-Type": EXT[ext] || "application/octet-stream", "Cache-Control": "private, max-age=86400" };
    if (url.searchParams.get("download") === "1") h["Content-Disposition"] = `attachment; filename="${pad.split("/").pop()}"`;
    return new Response(res.body, { headers: h });
  }

  if (actie === "verberg" && req.method === "POST") {
    const b = await req.json();
    await DB.prepare("UPDATE uploads SET verborgen = ?2 WHERE pad = ?1").bind(String(b.pad), b.verborgen ? 1 : 0).run();
    return json({ ok: true });
  }

  if (actie === "trek" && req.method === "POST") {
    const w = await DB.prepare(
      `SELECT id, naam, substr(id, -4) AS lot, vinkjes FROM bezoekers
       WHERE vinkjes >= ?1 AND winnaar = 0 AND naam != '' ORDER BY RANDOM() LIMIT 1`
    ).bind(VINKJES_NODIG).first();
    if (!w) return json({ fout: "Er is niemand meer om uit te loten. Alleen wie een naam invulde doet mee." }, 404);
    await DB.prepare("UPDATE bezoekers SET winnaar = 1, bijgewerkt = ?2 WHERE id = ?1").bind(w.id, Date.now()).run();
    return json({ winnaar: { naam: w.naam, lot: w.lot, vinkjes: w.vinkjes } });
  }

  if (actie === "reset-loting" && req.method === "POST") {
    await DB.prepare("UPDATE bezoekers SET winnaar = 0").run();
    return json({ ok: true });
  }

  return json({ fout: "Onbekende beheeractie." }, 404);
}
