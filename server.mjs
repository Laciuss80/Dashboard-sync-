// ============================================================================
//  Homie sync server (Railway) — manuálne tlačidlo + automatická synchronizácia
//  - POST /sync  : spustí synchronizáciu (len pre prihláseného ownera)
//  - každú hodinu: automaticky (sync.mjs si sám ustráži okno Po–So 9–18)
//  Žiadne závislosti — len vstavané moduly Node 18+.
//
//  Premenné prostredia na Railway (Service → Variables):
//    SF_EMAIL, SF_API_KEY, SF_COMPANY_ID,
//    SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY
// ============================================================================

import { createServer } from "node:http";
import { spawn } from "node:child_process";

const SB_URL  = process.env.SUPABASE_URL;
const SB_ANON = process.env.SUPABASE_ANON_KEY;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const PORT    = process.env.PORT || 3000;

let current = null;   // prebiehajúci sync – ďalšie volanie sa naň len „pripojí“ (nie chyba)
function runSync(force) {
  if (current) return current;
  current = new Promise((resolve) => {
    const args = ["sync.mjs"]; if (force) args.push("--force");
    console.log(`[sync] štart ${new Date().toISOString()} force=${!!force}`);
    const ch = spawn("node", args, { env: process.env });
    let out = "";
    ch.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    ch.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    ch.on("error", (e) => { current = null; resolve({ ok: false, msg: "Nepodarilo sa spustiť sync: " + e.message }); });
    ch.on("close", (code) => { console.log(`[sync] koniec code=${code}`); current = null; resolve({ ok: code === 0, code, out: out.slice(-2000) }); });
  });
  return current;
}

// overí, že volajúci je prihlásený personál (owner alebo operatíva)
async function verifyStaff(token) {
  if (!token) return false;
  try {
    const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } });
    if (!u.ok) return false;
    const user = await u.json();
    const p = await fetch(`${SB_URL}/rest/v1/profile?id=eq.${user.id}&select=role`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    const d = await p.json();
    return Array.isArray(d) && d[0] && ["owner", "operativa"].includes(d[0].role);
  } catch { return false; }
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
}

createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (req.method === "POST" && req.url === "/sync") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!(await verifyStaff(token))) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "forbidden" })); return; }
    let r;
    try { r = await runSync(true); } catch (e) { r = { ok: false, msg: "Chyba servera: " + e.message }; }
    // „Sync už beží" nie je chyba – je to len upozornenie (409), nie 500
    const code = r.ok ? 200 : (r.msg === "Sync už beží" ? 409 : 500);
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r));
    return;
  }
  res.writeHead(404); res.end("not found");
}).listen(PORT, () => console.log("Homie sync server beží na porte", PORT));

// automatická synchronizácia každú hodinu (sync.mjs sám preskočí mimo okna)
runSync(false);
setInterval(() => runSync(false), 60 * 60 * 1000);
