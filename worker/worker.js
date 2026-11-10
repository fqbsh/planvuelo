// PlanVuelo: intermediario para METAR/TAF (aviationweather.gov), SimBrief y NOTAM (autorouter).
// Las credenciales de autorouter van como secretos del Worker: AUTOROUTER_USER y AUTOROUTER_PASS.
const PERMITIDOS = ["aviationweather.gov", "simbrief.com"];
let token = null, tokenHasta = 0;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

async function obtenerToken(env) {
  if (token && Date.now() < tokenHasta) return token;
  if (!env.AUTOROUTER_USER || !env.AUTOROUTER_PASS) throw new Error("Faltan las credenciales de autorouter en Cloudflare (AUTOROUTER_USER y AUTOROUTER_PASS).");
  const r = await fetch("https://api.autorouter.aero/v1.0/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.AUTOROUTER_USER, client_secret: env.AUTOROUTER_PASS }),
  });
  const t = await r.text();
  let j = {}; try { j = JSON.parse(t); } catch {}
  if (!r.ok || !j.access_token) throw new Error("autorouter rechazó el acceso (" + r.status + "): " + (j.error_description || j.error || t.slice(0, 120)));
  token = j.access_token;
  tokenHasta = Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000;
  return token;
}

async function notams(icao, env) {
  const ahora = Math.floor(Date.now() / 1000);
  const filas = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const q = new URLSearchParams({ itemas: JSON.stringify([icao]), offset: String(offset), limit: "100",
      startvalidity: String(ahora), endvalidity: String(ahora + 3 * 86400) });
    let r = await fetch("https://api.autorouter.aero/v1.0/notam?" + q, { headers: { Authorization: "Bearer " + (await obtenerToken(env)) } });
    if (r.status === 401) { token = null; r = await fetch("https://api.autorouter.aero/v1.0/notam?" + q, { headers: { Authorization: "Bearer " + (await obtenerToken(env)) } }); }
    if (!r.ok) throw new Error("autorouter respondió " + r.status + ": " + (await r.text()).slice(0, 120));
    const j = await r.json();
    const rows = j.rows || [];
    for (const n of rows) {
      if (n.suppressed) continue;
      const anio = String((n.year || 0) % 100).padStart(2, "0");
      filas.push({ id: (n.series || "") + String(n.number || 0).padStart(4, "0") + "/" + anio,
        start: n.startvalidity, end: n.endvalidity, d: n.itemd || "", e: n.iteme || "" });
    }
    if (rows.length < 100 || filas.length >= (j.total || 0)) break;
  }
  return filas;
}

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

async function rodajes(icao, lat, lon, ctx) {
  const clave = new Request("https://planvuelo.cache/osm/" + icao);
  const cache = caches.default;
  const guardado = await cache.match(clave);
  if (guardado) return guardado;
  const dy = 0.035, dx = 0.035 / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const bb = `${lat - dy},${lon - dx},${lat + dy},${lon + dx}`;
  const q = `[out:json][timeout:60];way["aeroway"~"^(taxiway|taxilane|apron|terminal)$"](${bb});out tags geom qt;`;
  const intentos = OVERPASS.map(u => fetch(u, { method: "POST", body: "data=" + encodeURIComponent(q),
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "PlanVuelo/1.0 (simulador)" } })
    .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }));
  const j = await Promise.any(intentos);
  const el = (j.elements || []).filter(e => e.geometry && e.tags).map(e => ({ a: e.tags.aeroway, r: e.tags.ref || "",
    g: e.geometry.map(p => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]) }));
  const resp = new Response(JSON.stringify({ el }), { headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=2592000" } });
  if (el.length) ctx.waitUntil(cache.put(clave, resp.clone()));
  return resp;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const u0 = new URL(request.url);

    if (u0.pathname === "/osm") {
      const icao = (u0.searchParams.get("icao") || "").toUpperCase();
      const lat = parseFloat(u0.searchParams.get("lat")), lon = parseFloat(u0.searchParams.get("lon"));
      if (!/^[A-Z0-9]{3,4}$/.test(icao) || !isFinite(lat) || !isFinite(lon)) return json({ error: "Datos inválidos" }, 400);
      try { return await rodajes(icao, lat, lon, ctx); }
      catch (e) { return json({ error: "OpenStreetMap no respondió" }, 502); }
    }

    if (u0.pathname === "/notam") {
      const icao = (u0.searchParams.get("icao") || "").toUpperCase();
      if (!/^[A-Z]{4}$/.test(icao)) return json({ error: "ICAO inválido" }, 400);
      try { return json({ rows: await notams(icao, env) }); }
      catch (e) { return json({ error: String(e.message || e) }, 502); }
    }

    const destino = u0.searchParams.get("url");
    if (!destino) return new Response("PlanVuelo: servidor funcionando", { headers: cors });

    let u;
    try { u = new URL(destino); } catch { return new Response("Dirección inválida", { status: 400, headers: cors }); }
    const permitido = PERMITIDOS.some(h => u.hostname === h || u.hostname.endsWith("." + h));
    if (u.protocol !== "https:" || !permitido) return new Response("Dirección no permitida", { status: 403, headers: cors });

    try {
      const r = await fetch(u.toString(), { headers: { "User-Agent": "PlanVuelo/1.0 (simulador)" } });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
    } catch (e) {
      return new Response("No se pudo consultar: " + e, { status: 502, headers: cors });
    }
  },
};
