/* Smart Pack AI — Packhouse Intelligence Console */

const API = "http://127.0.0.1:5000/api";

async function fetchJSON(url, opts = {}, ms = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

const PAGE = {
  dashboard: { title: "Overview & Analytics", sub: "Packhouse decision support & food waste analytics" },
  recommend: { title: "New spec", sub: "Commodity, climate, mill constraints" },
  results: { title: "Dossier", sub: "Barrier, MAP, shelf life, cost, QR" },
  history: { title: "Recommendation history", sub: "Saved company dossiers & performance logs" },
  history_compare: { title: "Compare past specs", sub: "Side-by-side evaluation of historical dossiers" },
  compare: { title: "Compare materials", sub: "Side-by-side technical evaluation" },
  calculator: { title: "Pack calculator", sub: "Film surface area, weight & batch economics" },
  verifier: { title: "Lot verifier", sub: "Authenticate QR lot identity & dossier" },
  materials: { title: "Materials mill & Admin", sub: "Stock-keeping films, database administration" },
  commodities: { title: "Commodity ledger", sub: "Moisture, pH, respiration, product profiles" },
  about: { title: "Documentation", sub: "System architecture, standards & engine mechanics" },
};

let currentCompany = localStorage.getItem("spa-company") || "GreenField Packhouses Ltd.";
let allCommodities = [];
let allMaterials = [];
let lastResults = null;
let acTimer = null;

function $(id) { return document.getElementById(id); }

function navigate(pageId) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("on"));
  const el = $("page-" + pageId);
  if (el) el.classList.add("on");
  document.querySelectorAll(".nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === pageId);
  });
  const meta = PAGE[pageId] || {};
  $("mast-title").textContent = meta.title || pageId;
  $("mast-sub").textContent = meta.sub || "";
  $("rail").classList.remove("open");
  
  if (pageId === "dashboard") updateDashboardAnalytics();
  if (pageId === "materials") loadMaterials();
  if (pageId === "commodities") loadCommoditiesTable();
  if (pageId === "compare") populateCompareSelectors();
  if (pageId === "history") loadHistoryTable();
  closeAc();
}

function updateCompanyDisplay() {
  const el = $("company-name-display");
  if (el) el.textContent = currentCompany;
}

function setCompany(name) {
  currentCompany = name;
  localStorage.setItem("spa-company", name);
  updateCompanyDisplay();
  updateDashboardAnalytics();
  renderHistory();
}

function payloadFromForm() {
  const num = (id) => {
    const v = $(id).value;
    return v === "" ? null : parseFloat(v);
  };
  return {
    company: currentCompany,
    commodity: $("inp-commodity").value.trim(),
    moisture: parseFloat($("inp-moisture").value),
    fat: parseFloat($("inp-fat").value),
    ph: parseFloat($("inp-ph").value),
    shelf_life_days: parseInt($("inp-shelf-life").value, 10) || 14,
    storage_type: document.querySelector("input[name=storage_type]:checked")?.value || "ambient",
    respiration_class: $("inp-respiration").value,
    prefer_eco: $("inp-eco").checked,
    cost_priority: $("inp-cost").value,
    has_map_equipment: $("inp-map").checked,
    quantity_kg: num("inp-quantity"),
    storage_temp_c: num("inp-temp"),
    relative_humidity: num("inp-rh"),
    transport_mode: $("inp-transport").value,
    transport_hours: num("inp-hours"),
  };
}

function updateRange(field) {
  const input = $("inp-" + field);
  const display = $("val-" + field);
  const val = parseFloat(input.value);
  display.textContent = field === "ph" ? val.toFixed(1) : val + "%";
}

async function loadCommoditiesData() {
  try {
    const d = await fetchJSON(API + "/commodities");
    if (d.success) {
      allCommodities = mergeCustomCommodities(d.data);
      renderDemos();
      return;
    }
  } catch (_) { /* offline mill */ }
  allCommodities = mergeCustomCommodities(FALLBACK_COMMODITIES);
  renderDemos();
}

function mergeCustomCommodities(base) {
  const custom = JSON.parse(localStorage.getItem("spa-custom-commodities") || "[]");
  const merged = [...custom, ...base];
  // deduplicate by commodity name
  const seen = new Set();
  return merged.filter((c) => {
    const k = (c.commodity || "").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function closeAc() { $("ac-list")?.classList.remove("open"); }

function autocompleteSearch(q) {
  clearTimeout(acTimer);
  if (!q) { closeAc(); return; }
  acTimer = setTimeout(() => {
    const matches = allCommodities.filter((c) =>
      (c.commodity || "").toLowerCase().includes(q.toLowerCase())
    ).slice(0, 8);
    const list = $("ac-list");
    if (!matches.length) { closeAc(); return; }
    list.innerHTML = matches.map((m) =>
      `<div class="ac-item" data-name="${m.commodity}" data-cat="${m.category || ""}" data-sub="${m.subcategory || ""}">
        <span>${m.commodity}</span><small>${m.category || ""}</small>
      </div>`
    ).join("");
    list.classList.add("open");
    list.querySelectorAll(".ac-item").forEach((item) => {
      item.onclick = () => selectCommodity(item.dataset.name, item.dataset.cat, item.dataset.sub);
    });
  }, 80);
}

async function selectCommodity(name, category, subcategory) {
  $("inp-commodity").value = name;
  $("inp-category").value = category || "";
  $("inp-subcategory").value = subcategory || "";
  closeAc();
  try {
    const d = await fetchJSON(API + "/commodity/" + encodeURIComponent(name));
    if (d.success) { autofill(d.data); return; }
  } catch (_) { /* fallback */ }
  const found = allCommodities.find((c) => c.commodity === name) || FALLBACK_DETAIL[name];
  if (found) autofill(found);
}

function autofill(data) {
  if (data.moisture_pct != null) { $("inp-moisture").value = parseFloat(data.moisture_pct); updateRange("moisture"); }
  if (data.fat_pct != null) { $("inp-fat").value = parseFloat(data.fat_pct); updateRange("fat"); }
  if (data.ph != null && String(data.ph) !== "nan") { $("inp-ph").value = parseFloat(data.ph); updateRange("ph"); }
  if (data.respiration_rate_class && data.respiration_rate_class !== "NA") {
    $("inp-respiration").value = data.respiration_rate_class;
  }
  if (data.storage_type_default) {
    const st = String(data.storage_type_default).trim().toLowerCase();
    const radio = document.querySelector(`input[name=storage_type][value="${st}"]`);
    if (radio) radio.checked = true;
  }
  if (data.optimal_temp_c != null && String(data.optimal_temp_c) !== "nan") {
    $("inp-temp").value = data.optimal_temp_c;
  }
  if (data.optimal_rh_pct != null && String(data.optimal_rh_pct) !== "nan") {
    $("inp-rh").value = data.optimal_rh_pct;
  }
  const st = data.storage_type_default || "ambient";
  const shelfKey = "shelf_life_" + st + "_days";
  if (data[shelfKey] != null && String(data[shelfKey]) !== "nan") {
    $("inp-shelf-life").value = data[shelfKey];
    $("hint-shelf").textContent = "ledger: " + data[shelfKey] + " d";
  }
  const note = $("autofill-note");
  note.style.display = "flex";
  note.textContent = "Ledger filled for " + (data.commodity || nameSafe(data));
  renderProfile(data);
}

function nameSafe(d) { return d.commodity || d.name || ""; }

function renderProfile(data) {
  $("profile-panel").style.display = "block";
  const rows = [
    ["Moisture", data.moisture_pct != null ? data.moisture_pct + "%" : "—"],
    ["Fat", data.fat_pct != null ? data.fat_pct + "%" : "—"],
    ["pH", data.ph != null && String(data.ph) !== "nan" ? data.ph : "—"],
    ["Respiration", data.respiration_rate_class || "—"],
    ["Optimum T", data.optimal_temp_c != null ? data.optimal_temp_c + "°C" : "—"],
    ["Optimum RH", data.optimal_rh_pct != null ? data.optimal_rh_pct + "%" : "—"],
    ["Ethylene out", data.ethylene_producer || "—"],
    ["Ethylene in", data.ethylene_sensitive || "—"],
  ];
  $("profile-body").innerHTML = rows.map(([k, v]) =>
    `<div class="profile-row"><span>${k}</span><b>${v}</b></div>`
  ).join("") + (data.notes ? `<p class="muted" style="margin-top:10px">${data.notes}</p>` : "");
}

const DEMOS = [
  { name: "Broccoli", storage: "chilled" },
  { name: "Mango", storage: "ambient" },
  { name: "Tomato", storage: "chilled" },
  { name: "Chips Snacks", storage: "ambient" },
  { name: "Spinach", storage: "chilled" },
  { name: "Chicken Meat", storage: "chilled" },
];

function renderDemos() {
  const box = $("demos");
  if (!box) return;
  box.innerHTML = DEMOS.map((d) =>
    `<button class="pill" type="button" data-demo="${d.name}" data-st="${d.storage}">${d.name}</button>`
  ).join("");
}

async function runDemo(name, storage) {
  navigate("recommend");
  $("inp-commodity").value = name;
  try {
    const d = await fetchJSON(API + "/commodity/" + encodeURIComponent(name));
    if (d.success) {
      autofill(d.data);
      $("inp-category").value = d.data.category || "";
      $("inp-subcategory").value = d.data.subcategory || "";
    }
  } catch (_) {
    const found = allCommodities.find((c) => c.commodity === name) || FALLBACK_DETAIL[name];
    if (found) autofill(found);
  }
  const radio = document.querySelector(`input[name=storage_type][value="${storage}"]`);
  if (radio) radio.checked = true;
  setTimeout(runRecommendation, 400);
}

async function runRecommendation() {
  const commodity = $("inp-commodity").value.trim();
  if (!commodity) { alert("Enter a commodity name."); return; }
  const payload = payloadFromForm();
  showLoad();
  try {
    const data = await fetchJSON(API + "/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    // Gemini can take longer on a cold request; give its explanation time to return.
    }, 90000);
    hideLoad();
    if (!data.success) { alert(data.error || "Engine error"); return; }
    finishResults(data, commodity);
  } catch (_) {
    hideLoad();
    finishResults(clientRecommend(payload), commodity);
  }
}

function finishResults(data, commodity) {
  lastResults = data;
  $("nav-results").style.display = "flex";
  renderResults(data, commodity);
  saveHistory(commodity, data);
  updateDashboardAnalytics();
  navigate("results");
}

function showLoad() {
  $("overlay").classList.add("on");
  for (let i = 1; i <= 5; i++) $("ls" + i).className = "";
  const delays = [0, 600, 2000, 4500, 7000];
  delays.forEach((t, i) => {
    setTimeout(() => {
      if (i) { $("ls" + i).className = "ok"; }
      $("ls" + (i + 1)).className = "on";
    }, t);
  });
}
function hideLoad() { $("overlay").classList.remove("on"); }

function renderResults(data, name) {
  $("results-empty").style.display = "none";
  $("results-content").style.display = "block";
  $("results-headline").textContent = name;
  
  // Render Food Waste & Optimization Insight Banner
  const topMat = data.recommendations?.[0];
  const shelf = data.shelf_life;
  if (shelf && topMat) {
    const extPct = Math.round(((shelf.recommended_pack_days - shelf.unpackaged_days) / shelf.unpackaged_days) * 100);
    $("insight-banner-text").textContent = `${topMat.short_name} extends shelf life by +${extPct}% (${shelf.recommended_pack_days} days target vs ${shelf.unpackaged_days} days unpackaged). Prevents spoilage & cuts post-harvest food waste.`;
    $("insight-tag").textContent = `+${extPct}% SHELF LIFE EXTENSION`;
  }

  renderAIExplanation(data);
  renderWhy(data);
  renderRecs(data.recommendations || []);
  renderEcoAlts(data.eco_alternatives || data.sustainability?.eco_alternatives || []);
  renderSpecs(data.specs || {});
  renderStructure(topMat);
  renderMap(data.map_composition || {});
  renderShelf(data.shelf_life || {});
  renderCost(data.cost || {});
  renderSustain(data.sustainability || {});
  renderStore(data.storage_guidelines || {});
  renderQR(data.traceability || {});
}

function renderAIExplanation(data) {
  const panel = $("ai-explanation-panel");
  const textEl = $("ai-explanation-text");
  const tagEl = $("engine-tag");
  if (!panel || !textEl) return;

  const engine = data.engine || "unknown";
  const geminiReview = data.gemini_review;
  let explanation = data.ai_explanation || "";
  if (geminiReview) {
    explanation = [
      geminiReview.recommendation && `What to choose: ${geminiReview.recommendation}`,
      geminiReview.why_it_fits && `Why it fits: ${geminiReview.why_it_fits}`,
      geminiReview.tradeoff && `Trade-off: ${geminiReview.tradeoff}`,
      geminiReview.assumptions && `Assumptions: ${geminiReview.assumptions}`,
    ].filter(Boolean).join("\n\n");
  }

  if (explanation) {
    textEl.textContent = explanation;
    panel.style.display = "block";
  } else {
    textEl.textContent = "AI explanation not available for this recommendation.";
    panel.style.display = "block";
  }

  if (engine.includes("gemini")) {
    tagEl.textContent = "GEMINI EXPLANATION + LOCAL ML";
    tagEl.className = "tag eco";
  } else if (engine.includes("local-tfidf")) {
    tagEl.textContent = "LOCAL ML MODEL";
    tagEl.className = "tag eco";
  } else if (engine.includes("rule") || engine.includes("fallback")) {
    tagEl.textContent = "RULE ENGINE";
    tagEl.className = "tag";
  } else {
    tagEl.textContent = "AI ENGINE";
    tagEl.className = "tag eco";
  }
}

function renderWhy(data) {
  const s = data.specs || {};
  const items = [
    ["Moisture class", s.moisture_class],
    ["Respiration", s.respiration_class],
    ["pH class", s.ph_class],
    ["Fat class", s.fat_class],
    ["Gas path", s.gas_permeability],
    ["MAP", s.map_suitability],
  ];
  $("why-grid").innerHTML = items.map(([k, v]) =>
    `<div class="spec"><div class="k">${k}</div><div class="v" style="font-size:16px">${v || "—"}</div></div>`
  ).join("");
}

function renderRecs(recs) {
  if (!recs.length) {
    $("rec-grid").innerHTML = "<p class='muted'>No mill match.</p>";
    return;
  }
  $("rec-grid").innerHTML = recs.map((rec, i) => {
    const tags = [];
    if (rec.biodegradable === "Yes") tags.push('<span class="tag eco">Compostable</span>');
    if (rec.recyclable === "Yes") tags.push('<span class="tag eco">Recyclable</span>');
    if (rec.map_compatible === "Yes") tags.push('<span class="tag map">MAP</span>');
    if (rec.heat_sealable === "Yes") tags.push('<span class="tag">Heat seal</span>');
    if (rec.uv_barrier === "Yes") tags.push('<span class="tag">UV</span>');
    tags.push(`<span class="tag">${rec.cost_tier} cost</span>`);
    const um = rec.recommended_thickness?.recommended_um;
    return `<article class="rec ${i === 0 ? "best" : ""}">
      <div class="rank">${i === 0 ? "TOP LOT" : "ALT " + i}</div>
      <h5>${rec.name}</h5>
      <div class="aka">${rec.short_name} · ${rec.category}</div>
      <div class="flex between"><span class="muted">Match</span><b>${rec.match_pct}%</b></div>
      <div class="bar"><i data-w="${rec.match_pct}"></i></div>
      <div class="specs-mini">
        <div><b>OTR</b><span>${rec.otr_range}</span></div>
        <div><b>WVTR</b><span>${rec.wvtr_range}</span></div>
        <div><b>CO₂TR</b><span>${rec.co2_range || "—"}</span></div>
        <div><b>Gauge</b><span>${um ? um + " µm" : rec.thickness_range}</span></div>
      </div>
      ${rec.justification ? `<div class="callout info" style="margin-bottom:10px"><b>AI Justification:</b> ${rec.justification}</div>` : ""}
      <p class="muted" style="margin-bottom:10px">${rec.description || ""}</p>
      <div class="tags">${tags.join("")}</div>
    </article>`;
  }).join("");
  requestAnimationFrame(() => {
    document.querySelectorAll(".bar i[data-w]").forEach((b) => { b.style.width = b.dataset.w + "%"; });
  });
}

function renderEcoAlts(list) {
  if (!list.length) {
    $("eco-alts").innerHTML = "<p class='muted'>Top picks already cover recyclable or compostable stock.</p>";
    return;
  }
  $("eco-alts").innerHTML = `<div class="pills">${list.slice(0, 6).map((m) =>
    `<span class="pill">${m.short_name || m.name} · ${m.biodegradable === "Yes" ? "bio" : "recycle"} · ${m.cost_tier || ""}</span>`
  ).join("")}</div>`;
}

function renderSpecs(specs) {
  const otr = specs.required_otr || {};
  const wvtr = specs.required_wvtr || {};
  const co2 = specs.required_co2tr || {};
  const mech = specs.mechanical || {};
  $("specs-grid").innerHTML = [
    ["OTR window", `${otr.min}–${otr.max}`, otr.unit, otr.note],
    ["WVTR window", `${wvtr.min}–${wvtr.max}`, wvtr.unit, wvtr.note],
    ["CO₂TR window", `${co2.min}–${co2.max}`, co2.unit, co2.note],
    ["Thickness", specs.recommended_thickness_um ? specs.recommended_thickness_um + " µm" : "—", "target gauge", "Within mill process window"],
    ["Sealability", specs.sealability || "Heat seal", "", ""],
    ["Mechanical", `${mech.puncture_resistance || "—"} puncture`, mech.tensile_strength ? mech.tensile_strength + " tensile" : "", mech.note || ""],
  ].map(([k, v, u, n]) =>
    `<div class="spec"><div class="k">${k}</div><div class="v">${v}</div><div class="u">${u || ""}</div><div class="n">${n || ""}</div></div>`
  ).join("");
}

function renderStructure(top) {
  const box = $("structure-box");
  if (!top) { box.innerHTML = ""; return; }
  const st = top.structure || {};
  const layers = (st.layers || []).map((l) =>
    `<div class="layer"><b>${l.layer}</b><span>${l.material}</span><span class="muted">${l.role}</span></div>`
  ).join("");
  box.innerHTML = `
    <p><b>${st.pack_format || "Pouch"}</b> · ${st.structure_type || ""} · seal: ${st.seal_type || "—"} · MAP: ${st.map_suitability || top.map_compatible}</p>
    <div class="layers" style="margin-top:12px">${layers}</div>
    <p class="muted" style="margin-top:12px">${top.recommended_thickness?.note || ""} Best for: ${top.best_for || "—"}. Avoid: ${top.avoid_for || "—"}.</p>
  `;
}

function renderMap(map) {
  const o2 = map.O2 ?? 0, co2 = map.CO2 ?? 0, n2 = map.N2 ?? 0;
  const colors = ["#c45c26", "#3d5a3c", "#a6843a"];
  const vals = [o2, co2, n2];
  const labels = ["O₂", "CO₂", "N₂"];
  const r = 64, c = 90, circ = 2 * Math.PI * r;
  let acc = 0;
  const arcs = vals.map((v, i) => {
    const len = (v / 100) * circ;
    const dash = `${len} ${circ - len}`;
    const rot = -90 + acc * 3.6;
    acc += v;
    return `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${colors[i]}" stroke-width="22"
      stroke-dasharray="${dash}" transform="rotate(${rot} ${c} ${c})" />`;
  }).join("");
  $("map-svg").innerHTML = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#ebe4d4" stroke-width="22"/>${arcs}
    <text x="${c}" y="${c - 4}" text-anchor="middle" font-size="13" fill="#1f1a14" font-family="Newsreader, serif">MAP</text>
    <text x="${c}" y="${c + 14}" text-anchor="middle" font-size="10" fill="#6d6256" font-family="IBM Plex Mono, monospace">100%</text>`;
  $("map-leg").innerHTML = labels.map((l, i) =>
    `<div><span class="dot" style="background:${colors[i]}"></span><span>${l}</span><b style="margin-left:auto">${vals[i]}%</b></div>`
  ).join("");
  $("map-note").textContent = map.note || "";
}

function renderShelf(sl) {
  const rows = [
    ["s-none", "Loose / unpackaged", sl.unpackaged_days],
    ["s-basic", "Generic film", sl.basic_pack_days],
    ["s-rec", "Recommended mill pick", sl.recommended_pack_days],
    ["s-map", "With MAP (if used)", sl.map_pack_days],
  ];
  const max = Math.max(sl.desired_days || 14, sl.map_pack_days || 1, sl.recommended_pack_days || 1, 1);
  $("shelf-box").innerHTML = rows.map(([cls, lab, d]) => {
    const w = Math.min(100, ((d || 0) / max) * 100);
    return `<div class="shelf-row ${cls}"><span>${lab}</span><div class="track"><div class="fill" data-w="${w}">${d || 0} d</div></div><b>${d || 0} d</b></div>`;
  }).join("") + `<p class="muted" style="margin-top:8px">Target ${sl.desired_days || "—"} days · ${sl.meets_target ? "window met" : "target may need MAP or colder store"}</p>`;
  $("shelf-note").textContent = sl.note || "";
  requestAnimationFrame(() => {
    document.querySelectorAll("#shelf-box .fill").forEach((f) => { f.style.width = f.dataset.w + "%"; });
  });
}

function renderCost(cost) {
  const opts = cost.options || [];
  const max = Math.max(...opts.map((o) => o.estimated_pack_inr || 0), 1);
  $("cost-box").innerHTML = `
    <p class="muted mb">Lot ${cost.quantity_kg || "—"} kg · film area ~${cost.assumed_film_area_m2 || "—"} m². Lowest: ${cost.lowest_cost_option || "—"} · spread ₹${cost.potential_savings_inr || 0}</p>
    ${opts.map((o) => {
      const w = ((o.estimated_pack_inr || 0) / max) * 100;
      return `<div class="cost-row"><span>${o.name} (${o.cost_tier})</span><div class="track"><div class="fill" data-w="${w}"></div></div><b>₹${o.estimated_pack_inr}</b></div>`;
    }).join("")}
    <p class="muted" style="margin-top:10px">${cost.note || ""}</p>`;
  requestAnimationFrame(() => {
    document.querySelectorAll("#cost-box .fill").forEach((f) => { f.style.width = f.dataset.w + "%"; });
  });
}

function renderSustain(s) {
  const score = s.primary_score ?? 0;
  const circ = 2 * Math.PI * 54;
  const off = circ - (score / 100) * circ;
  $("eco-box").innerHTML = `
    <div class="ring-row">
      <svg width="160" height="160" viewBox="0 0 160 160">
        <circle cx="80" cy="80" r="54" fill="none" stroke="#ebe4d4" stroke-width="12"/>
        <circle cx="80" cy="80" r="54" fill="none" stroke="#3d5a3c" stroke-width="12"
          stroke-dasharray="${circ}" stroke-dashoffset="${off}" transform="rotate(-90 80 80)" stroke-linecap="butt"/>
        <text x="80" y="76" text-anchor="middle" font-size="28" font-family="Newsreader, serif" fill="#1f1a14">${score}</text>
        <text x="80" y="94" text-anchor="middle" font-size="11" fill="#6d6256" font-family="IBM Plex Mono, monospace">GRADE ${s.grade || "—"}</text>
      </svg>
      <div>
        ${(s.ranked || []).map((r) => `<div class="profile-row"><span>${r.short_name}</span><b>${r.score} · ${r.recyclable === "Yes" ? "recycle" : ""} ${r.biodegradable === "Yes" ? "bio" : ""}</b></div>`).join("")}
        <p class="muted" style="margin-top:10px">${s.note || ""}</p>
      </div>
    </div>`;
}

function renderStore(g) {
  const cells = [
    ["Temperature", g.temperature],
    ["Relative humidity", g.relative_humidity],
    ["Light", g.light_exposure],
    ["Transit", g.transport],
    ["Shelf (ledger)", g.shelf_life_estimate],
  ];
  $("store-box").innerHTML = `<div class="spec-grid">${cells.map(([k, v]) =>
    `<div class="spec"><div class="k">${k}</div><div class="v" style="font-size:16px">${v || "—"}</div></div>`
  ).join("")}</div>
  <div style="margin-top:12px">${(g.special_notes || []).map((n) => `<div class="callout warn">${n}</div>`).join("")}</div>`;
}

function renderQR(tr) {
  const text = tr.qr_text || tr.pack_id || "SMARTPACK";
  const url = "https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=8&data=" + encodeURIComponent(text);
  $("qr-box").innerHTML = `<img alt="Lot QR" width="180" height="180" src="${url}" />`;
  $("pack-id").textContent = tr.pack_id || "";
  const p = tr.payload || {};
  $("qr-kv").innerHTML = Object.entries({
    "Pack ID": tr.pack_id,
    Company: currentCompany,
    Commodity: p.commodity,
    Material: p.material,
    Gauge: p.thickness_um ? p.thickness_um + " µm" : "—",
    Store: p.storage,
    Issued: p.issued_utc,
  }).map(([k, v]) => `<div class="kv"><b>${k}</b><span>${v || "—"}</span></div>`).join("");
}

function exportDossierJSON() {
  if (!lastResults) { alert("No active dossier to export."); return; }
  const exportPayload = {
    company: currentCompany,
    exported_at: new Date().toISOString(),
    dossier: lastResults,
  };
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportPayload, null, 2));
  const a = document.createElement("a");
  const filename = (lastResults.traceability?.pack_id || "dossier") + "_spec_sheet.json";
  a.setAttribute("href", dataStr);
  a.setAttribute("download", filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function populateCompareSelectors() {
  const mats = allMaterials.length ? allMaterials : FALLBACK_MATERIALS;
  const opts = mats.map((m) => `<option value="${m.id}">${m.name} (${m.short_name})</option>`).join("");
  ["cmp-mat1", "cmp-mat2", "cmp-mat3"].forEach((id, idx) => {
    const sel = $(id);
    if (sel && (!sel.children.length || sel.children.length !== mats.length)) {
      sel.innerHTML = opts;
      if (mats[idx]) sel.value = mats[idx].id;
    }
  });
}

function runMaterialComparison() {
  const mats = allMaterials.length ? allMaterials : FALLBACK_MATERIALS;
  const id1 = parseInt($("cmp-mat1").value, 10);
  const id2 = parseInt($("cmp-mat2").value, 10);
  const id3 = parseInt($("cmp-mat3").value, 10);
  
  const m1 = mats.find((m) => m.id === id1) || mats[0];
  const m2 = mats.find((m) => m.id === id2) || mats[1] || mats[0];
  const m3 = mats.find((m) => m.id === id3) || mats[2] || mats[0];
  
  const selected = [m1, m2, m3];
  
  $("cmp-table-head").innerHTML = `<th>Technical Feature</th>` + selected.map((m) => `<th>${m.name} <small class="mono">(${m.short_name})</small></th>`).join("");
  
  const rows = [
    ["Category / Class", (m) => m.category],
    ["OTR Range (cc/m²/day)", (m) => `${m.otr_min} – ${m.otr_max}`],
    ["WVTR Range (g/m²/day)", (m) => `${m.wvtr_min} – ${m.wvtr_max}`],
    ["CO₂TR Range (cc/m²/day)", (m) => m.co2_tr_min != null ? `${m.co2_tr_min} – ${m.co2_tr_max}` : "—"],
    ["Thickness Window (µm)", (m) => `${m.thickness_min} – ${m.thickness_max} µm`],
    ["MAP Compatible", (m) => m.map_compatible || "No"],
    ["Heat Sealable", (m) => m.heat_sealable || "No"],
    ["Biodegradable", (m) => m.biodegradable === "Yes" ? '<span class="tag eco">Compostable</span>' : "No"],
    ["Recyclable", (m) => m.recyclable === "Yes" ? '<span class="tag eco">Recyclable</span>' : "No"],
    ["Cost Tier", (m) => m.cost_tier],
    ["Description & Best For", (m) => `<b>${m.best_for || "General"}</b><br/><small class="muted">${m.description || ""}</small>`],
    ["Avoid For", (m) => m.avoid_for || "—"],
  ];
  
  $("cmp-table-body").innerHTML = rows.map(([label, fn]) =>
    `<tr><td class="main">${label}</td>` + selected.map((m) => `<td>${fn(m)}</td>`).join("") + `</tr>`
  ).join("");
  
  $("compare-results-wrap").style.display = "block";
}

function runPackCalculator() {
  const format = $("calc-format").value;
  const L = parseFloat($("calc-length").value) || 20;
  const W = parseFloat($("calc-width").value) || 15;
  const D = parseFloat($("calc-depth").value) || 4;
  const gauge = parseFloat($("calc-gauge").value) || 40;
  const packWeightG = parseFloat($("calc-pack-weight").value) || 500;
  const batchQtyKg = parseFloat($("calc-batch-qty").value) || 1000;
  
  let areaPerPouchM2 = 0;
  if (format === "pillow") {
    areaPerPouchM2 = (2 * (L * W) * 1.15) / 10000;
  } else if (format === "standup") {
    areaPerPouchM2 = ((2 * (L * W) + 2 * (D * W)) * 1.15) / 10000;
  } else {
    areaPerPouchM2 = ((L * W) * 1.10) / 10000;
  }
  
  const pouchesNeeded = Math.ceil((batchQtyKg * 1000) / packWeightG);
  const totalFilmAreaM2 = pouchesNeeded * areaPerPouchM2;
  const densityKgM3 = 920;
  const filmWeightKg = totalFilmAreaM2 * (gauge / 1000000) * densityKgM3;
  
  const estCostLow = Math.round(totalFilmAreaM2 * 12);
  const estCostMed = Math.round(totalFilmAreaM2 * 28);
  const estCostHigh = Math.round(totalFilmAreaM2 * 55);
  
  const costPerPackMed = (estCostMed / pouchesNeeded).toFixed(2);
  
  $("calc-output-box").innerHTML = `
    <div class="calc-metric-card">
      <div class="muted">Total Pouches Required</div>
      <div class="val">${pouchesNeeded.toLocaleString()} units</div>
    </div>
    <div class="calc-metric-card">
      <div class="muted">Total Film Surface Area</div>
      <div class="val">${totalFilmAreaM2.toFixed(1)} m²</div>
    </div>
    <div class="calc-metric-card">
      <div class="muted">Total Film Roll Weight</div>
      <div class="val">${filmWeightKg.toFixed(1)} kg</div>
    </div>
    <div class="calc-metric-card">
      <div class="muted">Estimated Film Cost (Balanced Tier)</div>
      <div class="val">₹${estCostMed.toLocaleString()} <small style="font-size:14px;color:var(--mute)">(~₹${costPerPackMed}/pack)</small></div>
    </div>
    <p class="muted" style="margin-top:12px">Cost ranges: Budget ₹${estCostLow.toLocaleString()} · Balanced ₹${estCostMed.toLocaleString()} · Premium Barrier ₹${estCostHigh.toLocaleString()}</p>
  `;
}

function runLotVerification() {
  const rawId = $("inp-verify-id").value.trim();
  if (!rawId) { alert("Enter a Pack ID or QR code text to verify."); return; }
  
  let targetId = rawId;
  if (rawId.includes("|")) {
    const parts = rawId.split("|");
    targetId = parts[1] || parts[0];
  }
  
  let matchData = null;
  const list = getHistoryList();
  const foundHist = list.find((h) => h.pack_id === targetId || (h.pack_id && h.pack_id.toLowerCase() === targetId.toLowerCase()));
  if (foundHist && lastResults) {
    matchData = lastResults;
  } else if (lastResults && lastResults.traceability?.pack_id === targetId) {
    matchData = lastResults;
  }
  
  const resBox = $("verify-result-box");
  resBox.style.display = "block";
  
  const packIdDisplay = targetId.startsWith("SPA-") ? targetId : "SPA-" + targetId.toUpperCase();
  const commodity = foundHist?.name || matchData?.inputs_used?.commodity || matchData?.traceability?.payload?.commodity || "Agricultural Commodity";
  const material = foundHist?.material || matchData?.recommendations?.[0]?.name || "High Barrier Multilayer Film";
  const thickness = matchData?.specs?.recommended_thickness_um ? matchData.specs.recommended_thickness_um + " µm" : "40 µm";
  const storage = matchData?.inputs_used?.storage_type || "Ambient";
  const issued = foundHist ? new Date(foundHist.t).toISOString() : new Date().toISOString();
  
  $("verify-kv-body").innerHTML = `
    <div class="profile-row"><span>Pack Lot ID</span><b class="mono">${packIdDisplay}</b></div>
    <div class="profile-row"><span>Company Workspace</span><b>${currentCompany}</b></div>
    <div class="profile-row"><span>Commodity</span><b>${commodity}</b></div>
    <div class="profile-row"><span>Specified Material</span><b>${material}</b></div>
    <div class="profile-row"><span>Target Gauge</span><b>${thickness}</b></div>
    <div class="profile-row"><span>Storage Climate</span><b>${storage}</b></div>
    <div class="profile-row"><span>Timestamp</span><b class="mono">${issued}</b></div>
  `;
  $("v-hash").textContent = Math.abs(hashCode(packIdDisplay + commodity)).toString(16).toUpperCase().padStart(16, "0");
}

function openMaterialModal(mat) {
  $("md-title").textContent = mat.name;
  $("md-short").textContent = mat.short_name;
  $("md-cat").textContent = mat.category;
  $("md-desc").textContent = mat.description || "High performance packaging material.";
  $("md-otr").textContent = `${mat.otr_min}–${mat.otr_max} cc/m²/day`;
  $("md-wvtr").textContent = `${mat.wvtr_min}–${mat.wvtr_max} g/m²/day`;
  $("md-co2").textContent = mat.co2_tr_min != null ? `${mat.co2_tr_min}–${mat.co2_tr_max} cc/m²/day` : "—";
  $("md-thick").textContent = `${mat.thickness_min}–${mat.thickness_max} µm`;
  $("md-cost").textContent = mat.cost_tier + " Cost";
  $("md-map").textContent = mat.map_compatible || "No";
  $("md-seal").textContent = mat.heat_sealable || "No";
  $("md-bio").textContent = mat.biodegradable || "No";
  $("md-recycle").textContent = mat.recyclable || "No";
  $("md-best").textContent = mat.best_for || "—";
  $("md-avoid").textContent = mat.avoid_for || "—";
  $("modal-material").classList.add("on");
}

async function loadMaterials() {
  try {
    const d = await fetchJSON(API + "/materials");
    if (d.success) {
      allMaterials = mergeCustomMaterials(d.data);
      renderMat(allMaterials);
      return;
    }
  } catch (_) { /* offline */ }
  allMaterials = mergeCustomMaterials(FALLBACK_MATERIALS);
  renderMat(allMaterials);
}

function mergeCustomMaterials(base) {
  const custom = JSON.parse(localStorage.getItem("spa-custom-materials") || "[]");
  const merged = [...custom, ...base];
  const seen = new Set();
  return merged.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

function renderMat(data) {
  $("materials-tbody").innerHTML = data.map((m) => `<tr>
    <td><div class="main">${m.name}</div><div class="muted">${m.short_name}</div></td>
    <td>${m.category}</td>
    <td>${m.otr_min}–${m.otr_max}</td>
    <td>${m.wvtr_min}–${m.wvtr_max}</td>
    <td>${m.co2_tr_min != null ? m.co2_tr_min + "–" + m.co2_tr_max : "—"}</td>
    <td>${m.thickness_min}–${m.thickness_max}</td>
    <td>${m.map_compatible || "—"}</td>
    <td>${m.heat_sealable || "—"}</td>
    <td>${m.biodegradable}</td>
    <td>${m.recyclable}</td>
    <td>${m.cost_tier}</td>
    <td>
      <button class="btn btn-ghost" style="padding:2px 6px;font-size:11px" onclick="event.stopPropagation();openAdminEditMaterial(${m.id})">Edit</button>
      <button class="btn btn-ghost" style="padding:2px 6px;font-size:11px" onclick="event.stopPropagation();openMaterialModalById(${m.id})">View</button>
    </td>
  </tr>`).join("");
}

function openMaterialModalById(id) {
  const mat = allMaterials.find((m) => m.id === id);
  if (mat) openMaterialModal(mat);
}

function openAdminEditMaterial(id) {
  const mat = allMaterials.find((m) => m.id === id);
  if (!mat) return;
  $("admin-mat-modal-title").textContent = "Edit Material Specification";
  $("admin-mat-id").value = mat.id;
  $("am-name").value = mat.name;
  $("am-short").value = mat.short_name;
  $("am-cat").value = mat.category;
  $("am-otr-min").value = mat.otr_min;
  $("am-otr-max").value = mat.otr_max;
  $("am-wvtr-min").value = mat.wvtr_min;
  $("am-wvtr-max").value = mat.wvtr_max;
  $("am-thick-min").value = mat.thickness_min;
  $("am-thick-max").value = mat.thickness_max;
  $("am-map").value = mat.map_compatible || "No";
  $("am-seal").value = mat.heat_sealable || "No";
  $("am-bio").value = mat.biodegradable || "No";
  $("am-recycle").value = mat.recyclable || "No";
  $("am-cost").value = mat.cost_tier || "Medium";
  $("modal-admin-material").classList.add("on");
}

function saveAdminMaterial() {
  const name = $("am-name").value.trim();
  if (!name) { alert("Material name is required."); return; }
  const idVal = $("admin-mat-id").value;
  const isEdit = Boolean(idVal);
  const matId = isEdit ? parseInt(idVal, 10) : Date.now();

  const newMat = {
    id: matId,
    name: name,
    short_name: $("am-short").value.trim() || name.slice(0, 8),
    category: $("am-cat").value.trim() || "Synthetic Polymer",
    otr_min: parseFloat($("am-otr-min").value) || 10,
    otr_max: parseFloat($("am-otr-max").value) || 1000,
    wvtr_min: parseFloat($("am-wvtr-min").value) || 1,
    wvtr_max: parseFloat($("am-wvtr-max").value) || 20,
    co2_tr_min: 50,
    co2_tr_max: 5000,
    thickness_min: parseFloat($("am-thick-min").value) || 20,
    thickness_max: parseFloat($("am-thick-max").value) || 100,
    map_compatible: $("am-map").value,
    heat_sealable: $("am-seal").value,
    biodegradable: $("am-bio").value,
    recyclable: $("am-recycle").value,
    cost_tier: $("am-cost").value,
    description: "Custom admin material entry.",
    best_for: "General food packaging",
    avoid_for: "Extreme heat",
  };

  const custom = JSON.parse(localStorage.getItem("spa-custom-materials") || "[]");
  if (isEdit) {
    const idx = custom.findIndex((m) => m.id === matId);
    if (idx !== -1) custom[idx] = newMat;
    else custom.unshift(newMat);
  } else {
    custom.unshift(newMat);
  }

  localStorage.setItem("spa-custom-materials", JSON.stringify(custom));
  allMaterials = mergeCustomMaterials(allMaterials);
  renderMat(allMaterials);
  populateCompareSelectors();
  $("modal-admin-material").classList.remove("on");
  alert(`Material '${name}' saved successfully to database!`);
}

function saveCustomProduct() {
  const name = $("np-name").value.trim();
  if (!name) { alert("Product name is required."); return; }
  const newProd = {
    commodity: name,
    category: $("np-category").value,
    subcategory: "Custom Product",
    moisture_pct: parseFloat($("np-moisture").value) || 85,
    fat_pct: parseFloat($("np-fat").value) || 0.5,
    ph: parseFloat($("np-ph").value) || 5.5,
    respiration_rate_class: $("np-respiration").value,
    optimal_temp_c: parseFloat($("np-temp").value) || 10,
    optimal_rh_pct: parseFloat($("np-rh").value) || 90,
    storage_type_default: "chilled",
    shelf_life_chilled_days: 14,
    notes: "Custom product added via company ledger.",
  };

  const custom = JSON.parse(localStorage.getItem("spa-custom-commodities") || "[]");
  custom.unshift(newProd);
  localStorage.setItem("spa-custom-commodities", JSON.stringify(custom));

  allCommodities = mergeCustomCommodities(allCommodities);
  renderCom(allCommodities);
  $("modal-add-product").classList.remove("on");
  alert(`Product '${name}' added to commodity ledger!`);
}

async function loadCommoditiesTable() {
  let data = allCommodities;
  if (!data.length) {
    try {
      const d = await fetchJSON(API + "/commodities");
      if (d.success) { data = mergeCustomCommodities(d.data); allCommodities = data; }
    } catch (_) { data = mergeCustomCommodities(FALLBACK_COMMODITIES); }
  }
  renderCom(data);
}

function renderCom(data) {
  $("commodities-tbody").innerHTML = data.map((c) => `<tr data-pick="${c.commodity}" style="cursor:pointer">
    <td class="main">${c.commodity}</td>
    <td>${c.category || "—"}</td>
    <td>${c.moisture_pct != null ? c.moisture_pct + "%" : "—"}</td>
    <td>${c.fat_pct != null ? c.fat_pct + "%" : "—"}</td>
    <td>${c.ph != null && String(c.ph) !== "nan" ? c.ph : "—"}</td>
    <td>${c.respiration_rate_class || "—"}</td>
    <td>${c.storage_type_default || "—"}</td>
    <td>${c.optimal_temp_c != null ? c.optimal_temp_c + "°C" : "—"}</td>
    <td>${c.optimal_rh_pct != null ? c.optimal_rh_pct + "%" : "—"}</td>
  </tr>`).join("");
}

function getHistoryList() {
  return JSON.parse(localStorage.getItem("spa-history") || "[]");
}

function saveHistory(name, data) {
  const rec = {
    company: currentCompany,
    pack_id: data.traceability?.pack_id,
    name,
    material: data.recommendations?.[0]?.short_name,
    full_material: data.recommendations?.[0]?.name,
    storage: data.inputs_used?.storage_type,
    thickness_um: data.specs?.recommended_thickness_um,
    match_pct: data.recommendations?.[0]?.match_pct,
    shelf_days: data.shelf_life?.recommended_pack_days,
    eco_grade: data.sustainability?.grade,
    t: Date.now(),
  };
  const list = getHistoryList();
  list.unshift(rec);
  localStorage.setItem("spa-history", JSON.stringify(list.slice(0, 50)));
  renderHistory();
}

function renderHistory() {
  const list = getHistoryList().filter((h) => !h.company || h.company === currentCompany);
  const box = $("history");
  if (!box) return;
  if (!list.length) { box.innerHTML = "<p class='muted'>No specs generated yet for this workspace.</p>"; return; }
  box.innerHTML = list.slice(0, 6).map((h) =>
    `<button type="button" data-hist="${h.name}">${h.name} · ${h.material || "mill"} · ${new Date(h.t).toLocaleDateString()}</button>`
  ).join("");
}

function loadHistoryTable() {
  const list = getHistoryList();
  const q = $("hist-search")?.value.toLowerCase() || "";
  const filtered = list.filter((h) =>
    ((h.name || "") + (h.material || "") + (h.pack_id || "") + (h.company || "")).toLowerCase().includes(q)
  );

  const tbody = $("history-full-tbody");
  if (!tbody) return;
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">No saved dossiers found in history.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map((h, i) => `
    <tr>
      <td><input type="checkbox" class="hist-chk" data-hist-idx="${i}" /></td>
      <td><b class="mono" style="font-size:12px">${h.pack_id || "SPA-—"}</b></td>
      <td class="main">${h.name}</td>
      <td>${h.full_material || h.material || "—"}</td>
      <td>${h.storage || "ambient"}</td>
      <td class="mono" style="font-size:11px">${new Date(h.t).toLocaleString()}</td>
      <td>
        <button class="btn btn-ghost" style="padding:2px 8px;font-size:12px" onclick="runDemo('${h.name}', '${h.storage || "ambient"}')">Re-run</button>
      </td>
    </tr>
  `).join("");
}

function compareSelectedHistory() {
  const chks = document.querySelectorAll(".hist-chk:checked");
  if (chks.length < 2) { alert("Select at least 2 dossiers from history to compare."); return; }
  const list = getHistoryList();
  const selected = Array.from(chks).slice(0, 3).map((c) => list[parseInt(c.dataset.histIdx, 10)]);
  
  navigate("history_compare");
  const container = $("hist-cmp-container");
  container.innerHTML = `
    <div class="table-wrap">
      <table class="data cmp-table">
        <thead>
          <tr>
            <th>Dossier Metric</th>
            ${selected.map((s) => `<th>${s.name}<br/><small class="mono">${s.pack_id || "—"}</small></th>`).join("")}
          </tr>
        </thead>
        <tbody>
          <tr><td class="main">Commodity</td>${selected.map((s) => `<td>${s.name}</td>`).join("")}</tr>
          <tr><td class="main">Recommended Material</td>${selected.map((s) => `<td><b>${s.full_material || s.material}</b></td>`).join("")}</tr>
          <tr><td class="main">Storage Zone</td>${selected.map((s) => `<td>${s.storage || "ambient"}</td>`).join("")}</tr>
          <tr><td class="main">Match Score</td>${selected.map((s) => `<td><b>${s.match_pct || 85}%</b></td>`).join("")}</tr>
          <tr><td class="main">Recommended Thickness</td>${selected.map((s) => `<td>${s.thickness_um || 40} µm</td>`).join("")}</tr>
          <tr><td class="main">Target Shelf Life</td>${selected.map((s) => `<td>${s.shelf_days || "—"} days</td>`).join("")}</tr>
          <tr><td class="main">Sustainability Grade</td>${selected.map((s) => `<td>Grade ${s.eco_grade || "B"}</td>`).join("")}</tr>
          <tr><td class="main">Timestamp</td>${selected.map((s) => `<td class="mono" style="font-size:11px">${new Date(s.t).toLocaleString()}</td>`).join("")}</tr>
        </tbody>
      </table>
    </div>
  `;
}

function updateDashboardAnalytics() {
  const list = getHistoryList();
  const totalSpecs = Math.max(12, list.length);
  const wasteSavedTons = (totalSpecs * 0.35).toFixed(1);
  
  if ($("dash-total-specs")) $("dash-total-specs").textContent = totalSpecs;
  if ($("dash-waste-saved")) $("dash-waste-saved").textContent = wasteSavedTons + " T";
}

/* Offline mill — mirrors the Python windows */
function clientRecommend(inp) {
  const detail = allCommodities.find((c) => c.commodity === inp.commodity) || FALLBACK_DETAIL[inp.commodity];
  const resp = inp.respiration_class || detail?.respiration_rate_class || "Moderate";
  const moisture = inp.moisture;
  const storage = inp.storage_type;
  const OTR = {
    "Very High": { chilled: [5000, 300000], ambient: [2000, 100000], frozen: [50, 500] },
    High: { chilled: [1000, 10000], ambient: [500, 5000], frozen: [50, 500] },
    Moderate: { chilled: [100, 2000], ambient: [50, 1000], frozen: [10, 100] },
    Low: { chilled: [10, 500], ambient: [10, 200], frozen: [1, 50] },
    "Very Low": { chilled: [1, 100], ambient: [1, 50], frozen: [0.1, 10] },
    NA: { chilled: [1, 50], ambient: [1, 200], frozen: [0.1, 5] },
  };
  const otr = OTR[resp]?.[storage] || [10, 1000];
  const wvtr = storage === "frozen" ? [0.01, 0.5]
    : moisture >= 85 ? [5, 50] : moisture >= 60 ? [2, 20] : moisture >= 20 ? [0.5, 5] : [0.01, 1];
  const co2 = (resp === "Very High" || resp === "High") && storage !== "frozen" ? [1000, 400000] : [0.1, 8000];
  const mech = {
    puncture_resistance: ["road", "sea", "last-mile"].includes(inp.transport_mode) ? "High" : "Medium",
    tensile_strength: inp.transport_mode === "sea" ? "High" : "Medium",
    flex_crack_resistance: inp.transport_mode === "air" ? "High" : "Medium",
    note: "Transit " + (inp.transport_mode || "road"),
  };
  
  const mats = allMaterials.length ? allMaterials : FALLBACK_MATERIALS;
  const scored = mats.map((m) => {
    let s = 0;
    if (m.otr_min <= otr[1] && m.otr_max >= otr[0]) s += 32;
    if (m.wvtr_min <= wvtr[1] && m.wvtr_max >= wvtr[0]) s += 22;
    if (inp.prefer_eco && m.biodegradable === "Yes") s += 8;
    if (inp.prefer_eco && m.recyclable === "Yes") s += 3;
    if (m.heat_sealable === "Yes") s += 4;
    if (inp.has_map_equipment && m.map_compatible === "Yes") s += 5;
    const want = inp.cost_priority === "low_cost" ? "Low" : inp.cost_priority === "quality_first" ? "High" : "Medium";
    if (m.cost_tier === want) s += 8;
    return { ...m, score: s, match_pct: Math.min(100, s) };
  }).sort((a, b) => b.score - a.score);
  
  const top3 = scored.slice(0, 3).map((m) => fmtClient(m, mech, resp, inp));
  const eco = scored.filter((m) => m.biodegradable === "Yes" || m.recyclable === "Yes")
    .filter((m) => !top3.find((t) => t.id === m.id)).slice(0, 3).map((m) => fmtClient(m, mech, resp, inp));
  const mapComp = (resp === "Very High" || resp === "High")
    ? { O2: 5, CO2: 10, N2: 85, note: "Low O₂ + moderate CO₂ slows respiration" }
    : storage === "frozen" || resp === "NA"
      ? { O2: 0, CO2: 0, N2: 100, note: "Nitrogen flush" }
      : { O2: 5, CO2: 5, N2: 90, note: "Standard produce MAP" };
  const match = top3[0]?.match_pct || 50;
  const base = parseInt(detail?.["shelf_life_" + storage + "_days"] || inp.shelf_life_days, 10) || 14;
  const recDays = Math.max(1, Math.round(base * (0.85 + match / 100 * 0.35)));
  const qty = inp.quantity_kg || 100;
  const area = Math.max(1, qty * 0.08);
  const rates = { Low: 12, Medium: 28, High: 55 };
  const costOpts = top3.map((m) => ({
    name: m.short_name, cost_tier: m.cost_tier,
    estimated_pack_inr: Math.round(area * (rates[m.cost_tier] || 28)),
    inr_per_kg: 0,
  }));
  const packId = "SPA-" + Math.abs(hashCode(inp.commodity + (top3[0]?.short_name || ""))).toString(16).toUpperCase().slice(0, 8);
  return {
    success: true,
    engine: "client-smart-pack",
    ai_explanation: `Recommendation formulated for ${inp.commodity} under ${storage} conditions. Based on physical profile (${inp.moisture}% moisture, pH ${inp.ph}, respiration class: ${resp}), ${top3[0]?.name || "selected film"} is recommended to balance oxygen transmission and moisture retention while maximizing storage shelf life.`,
    commodity_info: detail || null,
    recommendations: top3,
    eco_alternatives: eco,
    specs: {
      required_otr: { min: otr[0], max: otr[1], unit: "cc/m²/day", note: resp + " · " + storage },
      required_wvtr: { min: wvtr[0], max: wvtr[1], unit: "g/m²/day", note: moisture + "% moisture" },
      required_co2tr: { min: co2[0], max: co2[1], unit: "cc/m²/day", note: "Gas exchange window" },
      gas_permeability: (resp === "Very High" || resp === "High") && storage !== "frozen" ? "High (breathable)" : "Low (barrier)",
      sealability: "Heat-seal recommended",
      map_suitability: inp.has_map_equipment ? "Recommended" : "Optional",
      respiration_class: resp,
      moisture_class: moisture >= 85 ? "Very High (>85%)" : moisture >= 60 ? "High (60–85%)" : moisture >= 20 ? "Moderate (20–60%)" : "Low (<20%)",
      fat_class: inp.fat >= 20 ? "High fat (>20%)" : inp.fat >= 5 ? "Moderate fat (5–20%)" : "Low fat (<5%)",
      ph_class: inp.ph < 3.5 ? "Highly Acidic" : inp.ph < 5 ? "Acidic" : inp.ph < 6 ? "Slightly Acidic" : "Near Neutral",
      mechanical: mech,
      recommended_thickness_um: top3[0]?.recommended_thickness?.recommended_um,
    },
    map_composition: mapComp,
    storage_guidelines: {
      temperature: detail?.optimal_temp_c != null ? detail.optimal_temp_c + "°C" : storage === "chilled" ? "2–8°C" : storage === "frozen" ? "−18°C" : "15–25°C",
      relative_humidity: detail?.optimal_rh_pct ? detail.optimal_rh_pct + "%" : "70–90% RH",
      light_exposure: "Avoid direct sunlight and UV",
      transport: (inp.transport_mode || "road") + " · ~" + (inp.transport_hours || 12) + " h",
      shelf_life_estimate: base + " days (ledger)",
      special_notes: detail?.notes ? [detail.notes] : [],
    },
    shelf_life: {
      unpackaged_days: Math.max(1, Math.round(base * 0.35)),
      basic_pack_days: Math.max(1, Math.round(base * 0.7)),
      recommended_pack_days: recDays,
      map_pack_days: inp.has_map_equipment ? Math.round(recDays * 1.25) : recDays,
      desired_days: inp.shelf_life_days,
      meets_target: recDays >= inp.shelf_life_days,
      note: "Offline mill estimate. Confirm with a pack trial.",
    },
    cost: {
      quantity_kg: qty, assumed_film_area_m2: Math.round(area * 10) / 10, options: costOpts,
      lowest_cost_option: costOpts.slice().sort((a, b) => a.estimated_pack_inr - b.estimated_pack_inr)[0]?.name,
      potential_savings_inr: Math.max(0, Math.max(...costOpts.map((o) => o.estimated_pack_inr)) - Math.min(...costOpts.map((o) => o.estimated_pack_inr))),
      note: "Indicative film cost only.",
    },
    sustainability: {
      primary_score: top3[0]?.biodegradable === "Yes" ? 80 : top3[0]?.recyclable === "Yes" ? 55 : 28,
      grade: top3[0]?.biodegradable === "Yes" ? "A" : "C",
      ranked: top3.map((m) => ({ short_name: m.short_name, score: m.biodegradable === "Yes" ? 80 : 50, recyclable: m.recyclable, biodegradable: m.biodegradable })),
      eco_alternatives: eco,
      note: "Offline circular score.",
    },
    traceability: {
      pack_id: packId,
      qr_text: "SMARTPACK|" + packId + "|" + inp.commodity,
      payload: { pack_id: packId, commodity: inp.commodity, material: top3[0]?.name, short_name: top3[0]?.short_name, storage: storage, issued_utc: new Date().toISOString() },
    },
  };
}

function fmtClient(m, mech, resp, inp) {
  const tmin = m.thickness_min, tmax = m.thickness_max;
  const rec = Math.round((tmin + tmax) / 2);
  const breathable = m.category === "Breathable Film";
  return {
    ...m,
    otr_range: `${m.otr_min}–${m.otr_max} cc/m²/day`,
    wvtr_range: `${m.wvtr_min}–${m.wvtr_max} g/m²/day`,
    co2_range: `${m.co2_tr_min}–${m.co2_tr_max} cc/m²/day`,
    thickness_range: `${tmin}–${tmax} µm`,
    recommended_thickness: { recommended_um: rec, note: "Specify " + rec + " µm" },
    structure: {
      pack_format: breathable ? "Micro-perforated pillow pouch" : "Monolayer / laminate pouch",
      structure_type: breathable ? "Perforated monolayer" : "Film",
      layers: [{ layer: "Primary", material: m.short_name, role: "Barrier / exchange" }],
      seal_type: m.heat_sealable === "Yes" ? "Heat seal" : "Mechanical",
      map_suitability: m.map_compatible,
    },
    mechanical: mech,
    color_barrier: m.uv_barrier,
    justification: `Offers optimal gas permeability (OTR: ${m.otr_min}–${m.otr_max}) and moisture protection suited for ${resp.toLowerCase()} respiration commodities.`,
  };
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return h;
}

const FALLBACK_COMMODITIES = [
  { commodity: "Tomato", category: "Vegetables", subcategory: "Fruit Vegetable", moisture_pct: 94.5, fat_pct: 0.2, ph: 4.2, respiration_rate_class: "Moderate", storage_type_default: "chilled", optimal_temp_c: 12, optimal_rh_pct: 90 },
  { commodity: "Mango", category: "Fruits", subcategory: "Tropical", moisture_pct: 83, fat_pct: 0.4, ph: 3.9, respiration_rate_class: "Moderate", storage_type_default: "ambient", optimal_temp_c: 13, optimal_rh_pct: 90 },
  { commodity: "Broccoli", category: "Vegetables", subcategory: "Brassica", moisture_pct: 89.3, fat_pct: 0.4, ph: 6.5, respiration_rate_class: "Very High", storage_type_default: "chilled", optimal_temp_c: 0, optimal_rh_pct: 95 },
  { commodity: "Spinach", category: "Vegetables", subcategory: "Leafy Green", moisture_pct: 91.6, fat_pct: 0.4, ph: 6.4, respiration_rate_class: "Very High", storage_type_default: "chilled", optimal_temp_c: 0, optimal_rh_pct: 98 },
  { commodity: "Chips Snacks", category: "Snacks", subcategory: "Fried", moisture_pct: 1.5, fat_pct: 35, ph: 6, respiration_rate_class: "NA", storage_type_default: "ambient", optimal_temp_c: 25, optimal_rh_pct: 65 },
  { commodity: "Chicken Meat", category: "Meat and Poultry", subcategory: "Poultry", moisture_pct: 75, fat_pct: 5, ph: 6.2, respiration_rate_class: "NA", storage_type_default: "chilled", optimal_temp_c: 2, optimal_rh_pct: 95 },
  { commodity: "Rice (Raw)", category: "Grains", subcategory: "Cereal", moisture_pct: 12, fat_pct: 1, ph: 6.5, respiration_rate_class: "NA", storage_type_default: "ambient", optimal_temp_c: 25, optimal_rh_pct: 60 },
  { commodity: "Apple", category: "Fruits", subcategory: "Temperate", moisture_pct: 85.6, fat_pct: 0.2, ph: 3.5, respiration_rate_class: "Low", storage_type_default: "chilled", optimal_temp_c: 0, optimal_rh_pct: 90 },
];

const FALLBACK_DETAIL = {
  Broccoli: { commodity: "Broccoli", category: "Vegetables", subcategory: "Brassica", moisture_pct: 89.3, fat_pct: 0.4, ph: 6.5, respiration_rate_class: "Very High", optimal_temp_c: 0, optimal_rh_pct: 95, storage_type_default: "chilled", shelf_life_chilled_days: 14, ethylene_producer: "Low", ethylene_sensitive: "High", notes: "Very high respiration — breathable or perforated film" },
  Mango: { commodity: "Mango", category: "Fruits", subcategory: "Tropical", moisture_pct: 83, fat_pct: 0.4, ph: 3.9, respiration_rate_class: "Moderate", optimal_temp_c: 13, optimal_rh_pct: 90, storage_type_default: "ambient", shelf_life_ambient_days: 5, ethylene_producer: "High", ethylene_sensitive: "High", notes: "Ripens at room temp" },
  Tomato: { commodity: "Tomato", category: "Vegetables", subcategory: "Fruit Vegetable", moisture_pct: 94.5, fat_pct: 0.2, ph: 4.2, respiration_rate_class: "Moderate", optimal_temp_c: 12, optimal_rh_pct: 90, storage_type_default: "chilled", shelf_life_chilled_days: 21, ethylene_producer: "High", ethylene_sensitive: "Moderate", notes: "Keep off ethylene-sensitive loads" },
  Spinach: { commodity: "Spinach", category: "Vegetables", subcategory: "Leafy Green", moisture_pct: 91.6, fat_pct: 0.4, ph: 6.4, respiration_rate_class: "Very High", optimal_temp_c: 0, optimal_rh_pct: 98, storage_type_default: "chilled", shelf_life_chilled_days: 7, notes: "MAP or perforated bags" },
  "Chips Snacks": { commodity: "Chips Snacks", category: "Snacks", subcategory: "Fried", moisture_pct: 1.5, fat_pct: 35, ph: 6, respiration_rate_class: "NA", optimal_temp_c: 25, optimal_rh_pct: 65, storage_type_default: "ambient", shelf_life_ambient_days: 60, notes: "Oxygen barrier + nitrogen flush" },
  "Chicken Meat": { commodity: "Chicken Meat", category: "Meat and Poultry", subcategory: "Poultry", moisture_pct: 75, fat_pct: 5, ph: 6.2, respiration_rate_class: "NA", optimal_temp_c: 2, optimal_rh_pct: 95, storage_type_default: "chilled", shelf_life_chilled_days: 7, notes: "MAP CO₂+N₂" },
};

const FALLBACK_MATERIALS = [
  { id: 1, name: "Low Density Polyethylene", short_name: "LDPE", category: "Synthetic Polymer", otr_min: 1500, otr_max: 3000, wvtr_min: 8, wvtr_max: 20, co2_tr_min: 5000, co2_tr_max: 10000, thickness_min: 20, thickness_max: 200, biodegradable: "No", recyclable: "Yes", heat_sealable: "Yes", map_compatible: "No", cost_tier: "Low", uv_barrier: "No", description: "Flexible moisture barrier, heat sealable.", best_for: "Roots, frozen, bakery", avoid_for: "High-fat, odour" },
  { id: 4, name: "Polyethylene Terephthalate", short_name: "PET", category: "Synthetic Polymer", otr_min: 3, otr_max: 50, wvtr_min: 0.5, wvtr_max: 2, co2_tr_min: 10, co2_tr_max: 150, thickness_min: 12, thickness_max: 250, biodegradable: "No", recyclable: "Yes", heat_sealable: "No", map_compatible: "Yes", cost_tier: "Medium", uv_barrier: "No", description: "Strong gas barrier and clarity.", best_for: "Juices, deli", avoid_for: "High-respiration produce" },
  { id: 6, name: "Metallized BOPP", short_name: "Met-BOPP", category: "Metallized Film", otr_min: 10, otr_max: 50, wvtr_min: 0.5, wvtr_max: 1.5, co2_tr_min: 30, co2_tr_max: 120, thickness_min: 18, thickness_max: 25, biodegradable: "No", recyclable: "Yes", heat_sealable: "Yes", map_compatible: "No", cost_tier: "Medium", uv_barrier: "Yes", description: "Moisture, oxygen and light barrier.", best_for: "Chips, coffee", avoid_for: "Fresh produce" },
  { id: 7, name: "Aluminum Foil Laminate", short_name: "Alu-Lam", category: "Laminates", otr_min: 0.01, otr_max: 0.1, wvtr_min: 0.01, wvtr_max: 0.05, co2_tr_min: 0.05, co2_tr_max: 0.5, thickness_min: 50, thickness_max: 150, biodegradable: "No", recyclable: "No", heat_sealable: "Yes", map_compatible: "Yes", cost_tier: "High", uv_barrier: "Yes", description: "Near-zero permeability.", best_for: "Coffee, retort", avoid_for: "Respiring produce" },
  { id: 10, name: "Polylactic Acid Film", short_name: "PLA", category: "Biodegradable Film", otr_min: 550, otr_max: 1200, wvtr_min: 80, wvtr_max: 200, co2_tr_min: 1800, co2_tr_max: 4500, thickness_min: 25, thickness_max: 50, biodegradable: "Yes", recyclable: "Yes", heat_sealable: "Yes", map_compatible: "No", cost_tier: "Medium", uv_barrier: "No", description: "Compostable short-life film.", best_for: "Salads, bakery", avoid_for: "Frozen, long life" },
  { id: 13, name: "Micro-perforated PP", short_name: "Micro-PP", category: "Breathable Film", otr_min: 50000, otr_max: 200000, wvtr_min: 20, wvtr_max: 80, co2_tr_min: 120000, co2_tr_max: 400000, thickness_min: 15, thickness_max: 30, biodegradable: "No", recyclable: "Yes", heat_sealable: "No", map_compatible: "No", cost_tier: "Medium", uv_barrier: "No", description: "Laser holes for high-respiration produce.", best_for: "Broccoli, mushrooms", avoid_for: "Dry goods, meat" },
  { id: 19, name: "Modified Atmosphere Bag", short_name: "MAP-PP", category: "MAP Packaging", otr_min: 500, otr_max: 2000, wvtr_min: 5, wvtr_max: 15, co2_tr_min: 1500, co2_tr_max: 5500, thickness_min: 30, thickness_max: 80, biodegradable: "No", recyclable: "Yes", heat_sealable: "Yes", map_compatible: "Yes", cost_tier: "High", uv_barrier: "No", description: "Pre-gassed protein packs.", best_for: "Meat, meals", avoid_for: "High-respiration produce" },
];

document.addEventListener("DOMContentLoaded", () => {
  updateCompanyDisplay();
  renderDemos();
  loadCommoditiesData();
  renderHistory();
  updateRange("moisture"); updateRange("fat"); updateRange("ph");

  document.querySelectorAll(".nav a").forEach((a) => {
    a.addEventListener("click", (e) => { e.preventDefault(); navigate(a.dataset.page); });
  });
  document.querySelectorAll("[data-go]").forEach((b) => {
    b.addEventListener("click", (e) => { e.preventDefault(); navigate(b.dataset.go); });
  });
  $("burger")?.addEventListener("click", () => $("rail").classList.toggle("open"));
  $("inp-commodity").addEventListener("input", (e) => autocompleteSearch(e.target.value));
  document.addEventListener("click", (e) => { if (!e.target.closest(".ac")) closeAc(); });
  ["moisture", "fat", "ph"].forEach((f) => $("inp-" + f).addEventListener("input", () => updateRange(f)));
  
  $("btn-run").addEventListener("click", runRecommendation);
  $("btn-export-json")?.addEventListener("click", exportDossierJSON);
  
  $("btn-run-compare")?.addEventListener("click", runMaterialComparison);
  $("btn-run-calc")?.addEventListener("click", runPackCalculator);
  $("btn-do-verify")?.addEventListener("click", runLotVerification);
  
  // Company login switcher
  $("company-badge-btn")?.addEventListener("click", () => $("modal-login").classList.add("on"));
  $("btn-open-login")?.addEventListener("click", () => $("modal-login").classList.add("on"));
  $("login-close")?.addEventListener("click", () => $("modal-login").classList.remove("on"));
  $("select-company-profile")?.addEventListener("change", (e) => {
    $("fg-custom-company").style.display = e.target.value === "custom" ? "flex" : "none";
  });
  $("btn-do-login")?.addEventListener("click", () => {
    const sel = $("select-company-profile").value;
    const name = sel === "custom" ? ($("inp-custom-company").value.trim() || "Custom Enterprise Workspace") : sel;
    setCompany(name);
    $("modal-login").classList.remove("on");
  });

  // Product Management Modal
  $("btn-open-add-prod")?.addEventListener("click", () => $("modal-add-product").classList.add("on"));
  $("add-prod-close")?.addEventListener("click", () => $("modal-add-product").classList.remove("on"));
  $("btn-save-product")?.addEventListener("click", saveCustomProduct);

  // Admin Material Modal
  $("btn-open-add-mat")?.addEventListener("click", () => {
    $("admin-mat-modal-title").textContent = "Add New Packaging Material";
    $("admin-mat-id").value = "";
    $("am-name").value = "";
    $("am-short").value = "";
    $("am-cat").value = "Synthetic Polymer";
    $("modal-admin-material").classList.add("on");
  });
  $("admin-mat-close")?.addEventListener("click", () => $("modal-admin-material").classList.remove("on"));
  $("btn-save-admin-material")?.addEventListener("click", saveAdminMaterial);

  // History Actions
  $("hist-search")?.addEventListener("input", loadHistoryTable);
  $("btn-compare-selected-hist")?.addEventListener("click", compareSelectedHistory);

  // Material Modal
  $("md-close")?.addEventListener("click", () => $("modal-material")?.classList.remove("on"));
  $("modal-material")?.addEventListener("click", (e) => {
    if (e.target === $("modal-material")) $("modal-material").classList.remove("on");
  });

  $("demos")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-demo]");
    if (b) runDemo(b.dataset.demo, b.dataset.st);
  });
  $("history")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-hist]");
    if (b) runDemo(b.dataset.hist, "chilled");
  });
  $("result-tabs")?.addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("on"));
    document.querySelectorAll(".tab-panel").forEach((x) => x.classList.remove("on"));
    t.classList.add("on");
    $("tab-" + t.dataset.tab)?.classList.add("on");
  });
  $("mat-search")?.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    renderMat(allMaterials.filter((m) => (m.name + m.category).toLowerCase().includes(q)));
  });
  $("com-search")?.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    renderCom(allCommodities.filter((c) => ((c.commodity || "") + (c.category || "")).toLowerCase().includes(q)));
  });
  $("commodities-tbody")?.addEventListener("click", (e) => {
    const tr = e.target.closest("[data-pick]");
    if (!tr) return;
    navigate("recommend");
    selectCommodity(tr.dataset.pick, "", "");
  });
  $("materials-tbody")?.addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr || e.target.tagName === "BUTTON") return;
    const matId = parseInt(tr.dataset.matId, 10);
    const mat = allMaterials.find((m) => m.id === matId);
    if (mat) openMaterialModal(mat);
  });
});
