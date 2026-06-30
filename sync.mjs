// ============================================================================
//  SuperFaktúra  ->  Supabase  sync  (Node 18+, žiadne závislosti)
// ============================================================================
//  Čo robí: stiahne zo SF faktúry (order/proforma/regular), náklady a bankové
//  účty a uloží ich do Supabase (tabuľky order, document, expense, payment,
//  client, bank_account). Idempotentné — môžeš spúšťať opakovane.
//
//  PRED spustením:
//   1) v Supabase spusti schema_v2.sql a potom schema_v3_patch.sql
//   2) nastav premenné prostredia (PowerShell):
//        $env:SF_EMAIL = "sygneasro@gmail.com"
//        $env:SF_API_KEY = "<celý SF kľúč>"
//        $env:SF_COMPANY_ID = "115311"
//        $env:SUPABASE_URL = "https://xxxx.supabase.co"
//        $env:SUPABASE_SERVICE_KEY = "<service_role kľúč zo Supabase>"
//   3) node sync.mjs
//
//  service_role kľúč nájdeš v Supabase: Project Settings -> API -> service_role.
//  Drž ho tajný (obchádza RLS). Sem do chatu ho nedávaj.
// ============================================================================

const SF_EMAIL   = process.env.SF_EMAIL;
const SF_APIKEY  = process.env.SF_API_KEY;
const SF_COMPANY = process.env.SF_COMPANY_ID || "";
const SB_URL     = process.env.SUPABASE_URL;
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY;
const SF_BASE    = "https://moja.superfaktura.sk";

for (const [k, v] of Object.entries({ SF_EMAIL, SF_APIKEY, SUPABASE_URL: SB_URL, SUPABASE_SERVICE_KEY: SB_KEY })) {
  if (!v) { console.error("Chýba premenná prostredia:", k); process.exit(1); }
}

const sfAuth =
  `SFAPI email=${encodeURIComponent(SF_EMAIL)}` +
  `&apikey=${encodeURIComponent(SF_APIKEY)}` +
  `&company_id=${encodeURIComponent(SF_COMPANY)}&module=HomieSync 0.1`;

// ---------- pomocné ----------
const d = (s) => {                       // dátum -> YYYY-MM-DD alebo null
  if (!s || typeof s !== "string") return null;
  const v = s.slice(0, 10);
  return (v === "0000-00-00" || v.length < 10) ? null : v;
};
const num = (x) => {                      // "10.0000" -> 10 ; prázdne -> null
  if (x === null || x === undefined || x === "") return null;
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
};
const code = (inv) =>
  inv.invoice_no_formatted ||
  (inv.name && (inv.name.match(/([A-Za-z]{2,4}\d+)/) || [])[1]) ||
  String(inv.id);

async function sf(path) {
  const res = await fetch(`${SF_BASE}${path}`, {
    headers: { Authorization: sfAuth, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
  });
  const t = await res.text();
  try { return JSON.parse(t); } catch { throw new Error(`SF ${path}: ${res.status} ${t.slice(0,120)}`); }
}

async function sbUpsert(table, rows, onConflict, mode = "merge") {
  if (!rows.length) return 0;
  const prefer = mode === "ignore" ? "resolution=ignore-duplicates" : "resolution=merge-duplicates";
  let done = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const res = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: `${prefer},return=minimal`,
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`Supabase ${table}: ${res.status} ${await res.text()}`);
    done += chunk.length;
  }
  return done;
}

async function sfPaged(type) {            // všetky strany faktúr daného typu
  const out = [];
  let page = 1, pages = 1;
  do {
    const seg = type ? `/type:${type}` : "";
    const j = await sf(`/invoices/index.json/listinfo:1/per_page:100/page:${page}${seg}`);
    const items = Array.isArray(j.items) ? j.items : Object.values(j.items || {});
    out.push(...items);
    pages = j.pageCount || 1;
    page++;
  } while (page <= pages);
  return out;
}

// SF občas v zozname vráti pri objednávke predvyplnený názov položky ("Názov a popis
// položky"), hoci v detaile sú názvy správne. Keď je názov prázdny alebo placeholder,
// dotiahneme názvy položiek priamo z detailu objednávky (jedno volanie navyše, len pre
// takéto objednávky — bežných sa to netýka).
const ITEM_PLACEHOLDER = "Názov a popis položky";
async function orderItemsName(inv) {
  const nm = (inv.items_name || "").trim();
  if (nm && !nm.includes(ITEM_PLACEHOLDER)) return nm;
  try {
    const j = await sf(`/invoices/view/${inv.id}.json`);
    const items = j.InvoiceItem || (j.Invoice && j.Invoice.InvoiceItem) || [];
    const names = items
      .map((it) => (it.name || "").trim())
      .filter((n) => n && !n.includes(ITEM_PLACEHOLDER));
    if (names.length) return names.join(", ");
  } catch (e) { /* detail nedostupný — necháme čo máme */ }
  return nm || null;
}

async function sfExpensesPaged() {
  const out = [];
  let page = 1, pages = 1;
  do {
    const j = await sf(`/expenses/index.json/listinfo:1/per_page:100/page:${page}`);
    const items = Array.isArray(j.items) ? j.items : Object.values(j.items || {});
    out.push(...items);
    pages = j.pageCount || 1;
    page++;
  } while (page <= pages);
  return out;
}

// ---------- kategórie nákladov: id -> { name, top, path } ----------
async function categoryMap() {
  const tree = await sf("/expenses/expense_categories");
  const map = {};
  const walk = (node, parentPath, topName) => {
    if (!node || typeof node !== "object") return;
    const name = (node.name || "").trim();
    const top = topName || name;
    const path = parentPath ? `${parentPath} > ${name}` : name;
    if (node.id != null) map[String(node.id)] = { name, top, path };
    const ch = node.children;
    if (ch && typeof ch === "object") for (const c of Object.values(ch)) walk(c, path, top);
  };
  for (const root of Object.values(tree)) walk(root, "", null);
  return map;
}

// ---------- mapovanie ----------
function proformaDocType(c) {
  const u = (c || "").toUpperCase();
  if (u.startsWith("FVZ")) return "zaloha1";
  if (u.startsWith("ZP"))  return "zaloha2";
  return "zaloha1";
}

const FORCE = process.argv.includes("--force") || process.env.SYNC_FORCE === "1";
function inWindow() {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Bratislava", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(new Date());
  const wd = p.find((x) => x.type === "weekday").value;          // Mon..Sun
  const hour = parseInt(p.find((x) => x.type === "hour").value, 10);
  return wd !== "Sun" && hour >= 9 && hour <= 18;                // Po–So, 9:00–18:00
}

(async () => {
  if (!FORCE && !inWindow()) { console.log("Mimo synchronizačného okna (Po–So 9–18 h). Preskakujem — šetrím API tokeny."); return; }
  console.log("Sync štart… (verzia: granulárne kategórie v5)");
  const cats = await categoryMap();

  const clients = new Map();   // sf_client_id -> row
  const orders = [];
  const documents = [];
  const payments = [];

  const addClient = (inv, cli) => {
    const cid = inv.client_id && String(inv.client_id);
    if (!cid || clients.has(cid)) return;
    clients.set(cid, {
      sf_client_id: cid,
      name: cli?.name || "—",
      ico: cli?.ico || null,
      email: cli?.email || null,
    });
  };

  // ----- FAKTÚRY -----
  for (const type of ["order", "proforma", "regular"]) {
    const recs = await sfPaged(type);
    for (const r of recs) {
      const inv = r.Invoice, cli = r.Client;
      addClient(inv, cli);
      const c = code(inv);

      if (type === "order") {
        const itemsName = await orderItemsName(inv);
        orders.push({
          code: c,
          sf_order_id: String(inv.id),
          sf_variable: inv.variable || null,
          sf_client_id: inv.client_id ? String(inv.client_id) : null,
          total: num(inv.total_amount),
          total_net: num(inv.amount),
          items_summary: itemsName,
          issued_at: d(inv.created),
        });
      } else {
        documents.push({
          sf_document_id: String(inv.id),
          doc_type: type === "regular" ? "koncova" : proformaDocType(c),
          sf_invoice_type: type,
          code: c,
          order_code: (inv.order_no || "").toString().trim() || null,  // "Číslo objednávky" OBJ… — správny kľúč párovania
          variable: inv.variable || null,
          proforma_id: inv.proforma_id ? String(inv.proforma_id) : null,
          sf_client_id: inv.client_id ? String(inv.client_id) : null,
          amount: num(inv.amount),
          vat: num(inv.vat),
          total: num(inv.total_amount),
          status: inv.status != null ? String(inv.status) : null,
          issued_at: d(inv.created),
          due_at: d(inv.due),
          paid_at: d(inv.paydate),
        });
        // príjmová platba (od klienta), ak je faktúra uhradená
        const paid = num(inv.amount_paid);
        if (d(inv.paydate) && (String(inv.status) === "3" || (paid && paid > 0))) {
          payments.push({
            sf_payment_id: `inv-${inv.id}`,
            direction: "in",
            source: "sf",
            sf_document_id: String(inv.id),
            amount: paid || num(inv.total_amount) || 0,
            paid_at: d(inv.paydate),
          });
        }
      }
    }
    console.log(`  faktúry ${type}: ${recs.length}`);
  }

  // ----- NÁKLADY -----
  const expenses = [];
  const expRecs = await sfExpensesPaged();
  for (const r of expRecs) {
    const e = r.Expense;
    const supplier = (r.Client?.[0]?.Client?.name || e.name || "").trim() || null;
    const cat = cats[String(e.expense_category_id)] || {};
    expenses.push({
      sf_expense_id: String(e.id),
      supplier_name: supplier,
      category: cat.name || null,
      category_top: cat.top || null,
      category_path: cat.path || null,
      sf_category_id: e.expense_category_id ? String(e.expense_category_id) : null,
      amount_no_vat: num(e.amount),
      vat: num(e.vat),
      total: num(e.total),
      status: e.status != null ? String(e.status) : null,
      issued_at: d(e.created),
      due_at: d(e.due),
      paid_at: d(e.paydate),
    });
    const eps = Array.isArray(r.ExpensePayment) ? r.ExpensePayment : [];
    if (eps.length) {
      for (const p of eps) {
        payments.push({
          sf_payment_id: `exp-${p.id}`,
          direction: "out",
          source: "sf",
          sf_expense_id: String(e.id),
          amount: num(p.amount) || 0,
          paid_at: d(p.created) || d(e.paydate),
        });
      }
    } else if (d(e.paydate) && String(e.status) === "3") {
      payments.push({
        sf_payment_id: `exp-doc-${e.id}`,
        direction: "out",
        source: "sf",
        sf_expense_id: String(e.id),
        amount: num(e.amount_paid) || num(e.total) || 0,
        paid_at: d(e.paydate),
      });
    }
  }
  console.log(`  náklady: ${expRecs.length}`);

  // ----- BANKOVÉ ÚČTY -----
  const baResp = await sf("/bank_accounts/index.json");
  const baList = Array.isArray(baResp.BankAccounts) ? baResp.BankAccounts : [];
  const bankAccounts = baList.map((x) => {
    const b = x.BankAccount || x;
    return {
      name: b.bank_name || "Účet",
      iban: b.iban || null,
      sf_bank_account_id: String(b.id),
      opening_balance: 0,
      active: /tatra/i.test(b.bank_name || ""),
    };
  });
  console.log(`  účty: ${bankAccounts.length}`);

  // ----- ZÁPIS -----
  // platby zjednotíme na rovnakú sadu kľúčov (PostgREST to vyžaduje)
  const payCols = ["sf_payment_id", "direction", "source", "sf_document_id", "sf_expense_id", "amount", "paid_at"];
  const payValid = payments
    .filter((p) => p.paid_at)
    .map((p) => Object.fromEntries(payCols.map((k) => [k, p[k] ?? null])));
  console.log("\nZapisujem do Supabase…");
  console.log("  client:       ", await sbUpsert("client",       [...clients.values()], "sf_client_id"));
  console.log("  order:        ", await sbUpsert("order",        orders,       "sf_order_id"));
  console.log("  document:     ", await sbUpsert("document",     documents,    "sf_document_id"));
  console.log("  expense:      ", await sbUpsert("expense",      expenses,     "sf_expense_id"));
  console.log("  payment:      ", await sbUpsert("payment",      payValid,     "sf_payment_id"));
  console.log("  bank_account: ", await sbUpsert("bank_account", bankAccounts, "sf_bank_account_id", "ignore"));

  // Spáruj doklady s objednávkami (order.code = document.order_code)
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/link_documents`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: "{}",
    });
    console.log("  párovanie faktúr:", r.ok ? "OK" : `chyba ${r.status}`);
  } catch (e) { console.log("  párovanie faktúr: preskočené (", e.message, ")"); }

  console.log("\nHotovo. Skontroluj tabuľky v Supabase (Table editor).");
})().catch((e) => { console.error("\nCHYBA:", e.message); process.exit(1); });
