"""
Smart Pack AI — Recommendation Engine
Rule-based + ML hybrid for food packaging materials.
Sources: USDA FoodData Central, FAO Post-Harvest Guidelines,
ASTM F1383, ISO 15105-1, Robertson (2013), Han (2014).
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np
import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")

UNLIMITED = 1_000_000.0


def _to_num(val, default=0.0) -> float:
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return default
    s = str(val).strip().lower()
    if s in ("", "nan", "na", "none"):
        return default
    if s == "unlimited":
        return UNLIMITED
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def load_data():
    materials = pd.read_csv(os.path.join(DATA_DIR, "packaging_materials.csv"))
    commodities = pd.read_csv(os.path.join(DATA_DIR, "commodity_data.csv"))
    for col in ("otr_min", "otr_max", "wvtr_min", "wvtr_max",
                "thickness_min", "thickness_max", "co2_tr_min", "co2_tr_max"):
        materials[col] = materials[col].map(lambda v: _to_num(v, 0.0))
    return materials, commodities


materials_df, commodities_df = load_data()


def get_commodity_info(commodity_name: str) -> Optional[dict]:
    if not commodity_name:
        return None
    name = commodity_name.strip().lower()
    match = commodities_df[commodities_df["commodity"].str.lower() == name]
    if not match.empty:
        return match.iloc[0].to_dict()
    match = commodities_df[commodities_df["commodity"].str.lower().str.contains(name, regex=False)]
    if not match.empty:
        return match.iloc[0].to_dict()
    return None


def _jsonable(records):
    out = []
    for row in records:
        clean = {}
        for k, v in row.items():
            if v is None or (isinstance(v, float) and np.isnan(v)):
                clean[k] = None
            elif isinstance(v, (np.integer,)):
                clean[k] = int(v)
            elif isinstance(v, (np.floating,)):
                clean[k] = float(v)
            else:
                s = str(v)
                clean[k] = None if s.lower() == "nan" else v
        out.append(clean)
    return out


def list_commodities():
    cols = [
        "commodity", "category", "subcategory", "moisture_pct", "fat_pct", "ph",
        "respiration_rate_class", "storage_type_default", "optimal_temp_c",
        "optimal_rh_pct", "ethylene_producer", "ethylene_sensitive",
    ]
    present = [c for c in cols if c in commodities_df.columns]
    return _jsonable(commodities_df[present].to_dict(orient="records"))


def list_materials():
    return _jsonable(materials_df.to_dict(orient="records"))


def determine_required_otr(respiration_rate_class: str, storage_type: str) -> tuple:
    otr_map = {
        ("Very High", "chilled"):  (5000, 300000, "Very high OTR — breathable or micro-perforated film"),
        ("Very High", "frozen"):   (50, 500, "Moderate OTR acceptable at frozen temperatures"),
        ("Very High", "ambient"):  (2000, 100000, "High OTR needed at ambient for high-respiration produce"),
        ("High", "chilled"):       (1000, 10000, "High OTR for chilled high-respiration produce"),
        ("High", "frozen"):        (50, 500, "Low–moderate OTR at frozen temperatures"),
        ("High", "ambient"):       (500, 5000, "Moderate–high OTR for ambient high-respiration produce"),
        ("Moderate", "chilled"):   (100, 2000, "Moderate OTR for chilled storage"),
        ("Moderate", "frozen"):    (10, 100, "Low OTR at frozen temperatures"),
        ("Moderate", "ambient"):   (50, 1000, "Moderate OTR for ambient storage"),
        ("Low", "chilled"):        (10, 500, "Low-to-moderate OTR for chilled low-respiration produce"),
        ("Low", "frozen"):         (1, 50, "Very low OTR for frozen low-respiration produce"),
        ("Low", "ambient"):        (10, 200, "Low OTR for ambient low-respiration produce"),
        ("Very Low", "chilled"):   (1, 100, "Very low OTR — moisture and contamination barrier dominate"),
        ("Very Low", "frozen"):    (0.1, 10, "Near-zero OTR at frozen temperatures"),
        ("Very Low", "ambient"):   (1, 50, "Very low OTR for ambient root/bulb vegetables"),
        ("NA", "chilled"):         (1, 50, "Low OTR — product is not respiring"),
        ("NA", "frozen"):          (0.1, 5, "Near-zero OTR for non-respiring frozen products"),
        ("NA", "ambient"):         (1, 200, "OTR driven by oxidation/rancidity, not respiration"),
    }
    key = (respiration_rate_class, storage_type)
    return otr_map.get(key, (10, 1000, "Standard OTR range applied"))


def determine_required_wvtr(moisture_pct: float, storage_type: str, rh_pct: Optional[float]) -> tuple:
    if storage_type == "frozen":
        return (0.01, 0.5, "Near-zero WVTR to prevent freezer burn")
    rh = rh_pct if rh_pct is not None else 75.0
    if moisture_pct >= 85:
        if storage_type == "chilled":
            note = "High moisture — moderate WVTR to limit condensation"
            lo, hi = 5.0, 50.0
        else:
            note = "High moisture ambient — WVTR must avoid sogginess"
            lo, hi = 10.0, 100.0
    elif moisture_pct >= 60:
        lo, hi, note = 2.0, 20.0, "Moderate moisture — low-to-moderate WVTR"
    elif moisture_pct >= 20:
        lo, hi, note = 0.5, 5.0, "Low moisture — low WVTR to prevent uptake"
    else:
        lo, hi, note = 0.01, 1.0, "Very low moisture — very low WVTR is critical"

    if rh >= 90 and moisture_pct < 20:
        lo = max(0.01, lo * 0.5)
        hi = max(lo, hi * 0.6)
        note += "; high store RH — tighten moisture barrier"
    elif rh <= 50 and moisture_pct >= 85:
        lo = lo * 0.7
        note += "; dry store air — watch product dehydration"
    return (lo, hi, note)


def determine_required_co2tr(respiration_rate_class: str, storage_type: str) -> tuple:
    if respiration_rate_class in ("Very High", "High") and storage_type != "frozen":
        return (1000, 400000, "High CO₂ transmission so packs do not go anaerobic")
    if respiration_rate_class == "Moderate":
        return (50, 8000, "Moderate CO₂ permeability for equilibrium MAP")
    return (0.1, 500, "Low CO₂ transmission for non-respiring or frozen goods")


def mechanical_requirement(transport_mode: str, quantity_kg: Optional[float],
                           category: str, storage_type: str) -> dict:
    mode = (transport_mode or "road").lower()
    puncture = "Medium"
    tensile = "Medium"
    flex = "Medium"
    note = "Standard handling strength"

    if mode in ("road", "last-mile", "last_mile"):
        puncture, tensile = "High", "High"
        note = "Road / last-mile: vibration, stacking and puncture risk"
    elif mode == "sea":
        puncture, tensile, flex = "High", "High", "High"
        note = "Sea freight: humidity, salt spray and long compression"
    elif mode == "rail":
        puncture, tensile = "High", "Medium"
        note = "Rail: shock loading and pallet compression"
    elif mode == "air":
        flex, tensile = "High", "Medium"
        note = "Air: pressure cycling; seal integrity is critical"

    cat = (category or "").lower()
    if any(k in cat for k in ("meat", "seafood", "dairy")):
        puncture = "High"
    if "liquid" in cat or storage_type == "frozen":
        tensile = "High"

    qty = quantity_kg or 0
    if qty >= 500:
        tensile = "High"
        note += "; bulk lot — specify higher gauge"

    return {
        "puncture_resistance": puncture,
        "tensile_strength": tensile,
        "flex_crack_resistance": flex,
        "note": note,
    }


def recommend_thickness(mat: dict, mech: dict, shelf_life_days: int, transport_mode: str) -> dict:
    tmin = _to_num(mat.get("thickness_min"), 20)
    tmax = _to_num(mat.get("thickness_max"), 80)
    mid = (tmin + tmax) / 2
    rec = mid
    if mech.get("puncture_resistance") == "High":
        rec = tmin + 0.7 * (tmax - tmin)
    if (shelf_life_days or 14) >= 90:
        rec = max(rec, tmin + 0.6 * (tmax - tmin))
    if (transport_mode or "").lower() in ("sea", "road"):
        rec = min(tmax, rec * 1.08)
    rec = round(max(tmin, min(tmax, rec)), 0)
    return {
        "recommended_um": rec,
        "range_um": [tmin, tmax],
        "note": f"Specify {int(rec)} µm within the {int(tmin)}–{int(tmax)} µm process window",
    }


def packaging_structure(mat: dict, resp_class: str, fat: float, moisture: float,
                        has_map: bool, storage_type: str) -> dict:
    short = str(mat.get("short_name", ""))
    cat = str(mat.get("category", ""))
    layers = []
    form = "Pouch"

    if "Breathable" in cat or short in ("Micro-PP", "AF-PP"):
        form = "Micro-perforated pillow pouch"
        layers = [
            {"layer": "Outer print", "material": "PP / AF-PP", "role": "Graphics, anti-fog"},
            {"layer": "Laser perforations", "material": short, "role": "Controlled O₂/CO₂ exchange"},
        ]
    elif "MAP" in cat or (has_map and str(mat.get("map_compatible")) == "Yes"):
        form = "MAP tray + lidding film" if storage_type != "frozen" else "MAP pouch"
        layers = [
            {"layer": "Tray / forming web", "material": "PET or PP", "role": "Structure, puncture"},
            {"layer": "Barrier / lid", "material": short, "role": "OTR/WVTR control"},
            {"layer": "Sealant", "material": "PE", "role": "Heat seal, leak-tight"},
        ]
    elif "Laminate" in cat or short in ("Alu-Lam", "Met-BOPP", "EVOH"):
        form = "Multilayer laminate pouch"
        layers = [
            {"layer": "Print / PET", "material": "PET 12 µm", "role": "Printability, scuff"},
            {"layer": "Barrier", "material": short, "role": "O₂, light, aroma"},
            {"layer": "Sealant", "material": "LDPE 30–50 µm", "role": "Heat seal"},
        ]
    elif "Biodegradable" in cat or "Paper" in cat or "Natural" in cat:
        form = "Mono-material compostable / paper pack"
        layers = [
            {"layer": "Primary", "material": short, "role": "Containment + breathability"},
        ]
    else:
        form = "Monolayer film pouch or overwrap"
        layers = [
            {"layer": "Primary film", "material": short, "role": "Barrier + seal"},
        ]

    if fat >= 20:
        layers.append({"layer": "Optional", "material": "Metallized or EVOH", "role": "Oxidation barrier for high-fat foods"})
    if moisture < 20 and resp_class == "NA":
        form = form + " with nitrogen flush"

    return {
        "pack_format": form,
        "structure_type": "Multilayer" if len(layers) > 1 else "Monolayer",
        "layers": layers,
        "seal_type": "Heat seal" if str(mat.get("heat_sealable")) == "Yes" else "Mechanical / sew / clip",
        "map_suitability": str(mat.get("map_compatible")),
    }


def score_material(material: dict, otr_req: tuple, wvtr_req: tuple, co2_req: tuple,
                   inputs: dict, commodity: Optional[dict], mech: dict) -> float:
    score = 0.0
    otr_min_req, otr_max_req = otr_req[0], otr_req[1]
    wvtr_min_req, wvtr_max_req = wvtr_req[0], wvtr_req[1]
    co2_min_req, co2_max_req = co2_req[0], co2_req[1]

    mat_otr_min = _to_num(material.get("otr_min"))
    mat_otr_max = _to_num(material.get("otr_max"), UNLIMITED)
    mat_wvtr_min = _to_num(material.get("wvtr_min"))
    mat_wvtr_max = _to_num(material.get("wvtr_max"), UNLIMITED)
    mat_co2_min = _to_num(material.get("co2_tr_min"))
    mat_co2_max = _to_num(material.get("co2_tr_max"), UNLIMITED)

    if mat_otr_min <= otr_max_req and mat_otr_max >= otr_min_req:
        overlap = min(mat_otr_max, otr_max_req) - max(mat_otr_min, otr_min_req)
        range_size = otr_max_req - otr_min_req if otr_max_req != otr_min_req else 1
        score += min(32, (overlap / range_size) * 32)

    if mat_wvtr_min <= wvtr_max_req and mat_wvtr_max >= wvtr_min_req:
        overlap = min(mat_wvtr_max, wvtr_max_req) - max(mat_wvtr_min, wvtr_min_req)
        range_size = wvtr_max_req - wvtr_min_req if wvtr_max_req != wvtr_min_req else 1
        score += min(22, (overlap / range_size) * 22)

    if mat_co2_min <= co2_max_req and mat_co2_max >= co2_min_req:
        score += 8

    if inputs.get("prefer_eco", False):
        if str(material.get("biodegradable", "No")).lower() == "yes":
            score += 8
        if str(material.get("recyclable", "No")).lower() == "yes":
            score += 3

    cost_pref = inputs.get("cost_priority", "balanced")
    cost_tier = str(material.get("cost_tier", "Medium")).lower()
    if cost_pref == "low_cost" and cost_tier == "low":
        score += 8
    elif cost_pref == "quality_first" and cost_tier == "high":
        score += 8
    elif cost_pref == "balanced" and cost_tier == "medium":
        score += 8
    elif cost_pref == "balanced":
        score += 4

    if inputs.get("has_map_equipment", False) and str(material.get("map_compatible", "No")).lower() == "yes":
        score += 5

    if str(material.get("heat_sealable", "No")).lower() == "yes":
        score += 4

    fat = float(inputs.get("fat") or 0)
    if fat >= 20 and str(material.get("uv_barrier", "No")).lower() == "yes":
        score += 4
    if fat >= 20 and mat_otr_max <= 50:
        score += 3

    mode = (inputs.get("transport_mode") or "road").lower()
    if mode in ("sea", "road") and mech.get("puncture_resistance") == "High":
        tmax = _to_num(material.get("thickness_max"), 0)
        if tmax >= 80:
            score += 3

    return round(min(100.0, score), 2)


def ml_similarity_scores(otr_req: tuple, wvtr_req: tuple) -> dict[int, float]:
    """Cosine similarity of each material's barrier window to the required window."""
    try:
        from sklearn.metrics.pairwise import cosine_similarity
        from sklearn.preprocessing import StandardScaler
    except Exception:
        return {}

    rows = []
    ids = []
    for _, row in materials_df.iterrows():
        ids.append(int(row["id"]))
        rows.append([
            np.log10(_to_num(row["otr_min"], 0.1) + 0.1),
            np.log10(_to_num(row["otr_max"], 1) + 0.1),
            np.log10(_to_num(row["wvtr_min"], 0.01) + 0.01),
            np.log10(_to_num(row["wvtr_max"], 1) + 0.01),
        ])
    X = np.array(rows, dtype=float)
    target = np.array([[
        np.log10(otr_req[0] + 0.1),
        np.log10(otr_req[1] + 0.1),
        np.log10(wvtr_req[0] + 0.01),
        np.log10(wvtr_req[1] + 0.01),
    ]], dtype=float)
    scaler = StandardScaler()
    Xs = scaler.fit_transform(np.vstack([X, target]))
    sims = cosine_similarity(Xs[:-1], Xs[-1:])
    out = {}
    for i, mid in enumerate(ids):
        out[mid] = float(max(0.0, sims[i][0]) * 100.0)
    return out


def get_map_composition(commodity: Optional[dict], storage_type: str, resp_class: str) -> dict:
    if storage_type == "frozen":
        return {"O2": 0, "CO2": 0, "N2": 100,
                "note": "Frozen goods: nitrogen flush only; MAP gases add little once respiration is halted"}
    if commodity is None:
        return {"O2": 5, "CO2": 10, "N2": 85, "note": "Generic produce MAP — confirm with a trial pack"}

    category = str(commodity.get("category", "")).lower()
    sub = str(commodity.get("subcategory", "")).lower()
    rc = (resp_class or str(commodity.get("respiration_rate_class", "Moderate"))).lower()

    if "meat" in category or "seafood" in category:
        return {"O2": 0, "CO2": 30, "N2": 70,
                "note": "High CO₂ inhibits spoilage flora; N₂ as filler. High-O₂ red-meat bloom packs are a separate retail format."}
    if "dairy" in category:
        return {"O2": 0, "CO2": 25, "N2": 75,
                "note": "CO₂ suppresses mold; exclude O₂ to limit rancidity"}
    if "leafy" in sub or rc == "very high":
        return {"O2": 5, "CO2": 10, "N2": 85,
                "note": "Low O₂ + moderate CO₂ slows respiration without anaerobic injury"}
    if rc in ("high", "moderate"):
        return {"O2": 5, "CO2": 5, "N2": 90,
                "note": "Equilibrium MAP for moderate–high respiration produce"}
    if any(k in category for k in ("grain", "spice", "snack", "pulse", "oil", "nut")):
        return {"O2": 0, "CO2": 0, "N2": 100,
                "note": "Nitrogen flush — full O₂ displacement for dry / high-fat goods"}
    return {"O2": 3, "CO2": 5, "N2": 92, "note": "General MAP starting point — validate with O₂/CO₂ headspace"}


def get_storage_guidelines(commodity: Optional[dict], storage_type: str, inputs: dict,
                           temp_c: Optional[float], rh_pct: Optional[float]) -> dict:
    guidelines = {
        "temperature": "",
        "relative_humidity": "",
        "light_exposure": "Avoid direct sunlight and UV",
        "transport": "",
        "special_notes": [],
        "shelf_life_estimate": "",
    }

    defaults = {"ambient": "15–25°C", "chilled": "0–8°C", "frozen": "−18°C or below"}
    rh_defaults = {"ambient": "55–70% RH", "chilled": "85–95% RH", "frozen": "sealed; ignore store RH"}

    if commodity:
        temp = commodity.get("optimal_temp_c", "")
        rh = commodity.get("optimal_rh_pct", "")
        if temp != "" and str(temp).lower() != "nan":
            guidelines["temperature"] = f"{temp}°C (commodity optimum)"
        if rh != "" and str(rh).lower() != "nan":
            guidelines["relative_humidity"] = f"{rh}% RH (commodity optimum)"

        eth_p = str(commodity.get("ethylene_producer", "")).lower()
        eth_s = str(commodity.get("ethylene_sensitive", "")).lower()
        if eth_p in ("yes", "high", "moderate", "very high"):
            guidelines["special_notes"].append("Ethylene producer — isolate from ethylene-sensitive loads")
        if eth_s in ("yes", "high", "moderate", "very high"):
            guidelines["special_notes"].append("Ethylene sensitive — keep away from banana, mango, tomato")

        shelf_key = f"shelf_life_{storage_type}_days"
        shelf = commodity.get(shelf_key, inputs.get("shelf_life_days"))
        if shelf and str(shelf).lower() != "nan":
            guidelines["shelf_life_estimate"] = f"{shelf} days in database for {storage_type} storage"

    if not guidelines["temperature"]:
        guidelines["temperature"] = defaults.get(storage_type, "Per storage type")
    if not guidelines["relative_humidity"]:
        guidelines["relative_humidity"] = rh_defaults.get(storage_type, "Standard")

    if temp_c is not None:
        guidelines["special_notes"].append(f"Declared store temperature: {temp_c}°C")
    if rh_pct is not None:
        guidelines["special_notes"].append(f"Declared store RH: {rh_pct}%")

    mode = inputs.get("transport_mode") or "road"
    hours = inputs.get("transport_hours") or 12
    guidelines["transport"] = f"{mode.replace('_', ' ').title()} · ~{hours} h in transit"

    if storage_type == "chilled":
        guidelines["special_notes"].append("Hold the cold chain from pack-house to retail")
    elif storage_type == "frozen":
        guidelines["special_notes"].append("No freeze–thaw cycles; keep ≤ −18°C")
    else:
        guidelines["special_notes"].append("Buffer against humidity swings and heat spikes")

    return guidelines


def predict_shelf_life(commodity: Optional[dict], storage_type: str, desired: int,
                       match_pct: float, has_map: bool, map_compatible: bool,
                       temp_c: Optional[float], transport_hours: Optional[float]) -> dict:
    base = desired or 14
    if commodity:
        key = f"shelf_life_{storage_type}_days"
        raw = commodity.get(key)
        if raw is not None and str(raw).lower() != "nan":
            base = float(raw)

    unpackaged = max(1, round(base * 0.35))
    basic = max(1, round(base * 0.7))
    recommended = max(1, round(base * (0.85 + (match_pct / 100.0) * 0.35)))
    with_map = recommended
    if has_map and map_compatible:
        with_map = round(recommended * 1.25)

    if commodity and temp_c is not None:
        opt = _to_num(commodity.get("optimal_temp_c"), temp_c)
        delta = abs(temp_c - opt)
        if storage_type != "frozen" and delta > 3:
            factor = max(0.55, 1 - 0.06 * delta)
            recommended = max(1, round(recommended * factor))
            with_map = max(1, round(with_map * factor))

    hours = transport_hours or 0
    if hours > 48:
        recommended = max(1, round(recommended * 0.9))
        with_map = max(1, round(with_map * 0.92))

    return {
        "unpackaged_days": unpackaged,
        "basic_pack_days": basic,
        "recommended_pack_days": recommended,
        "map_pack_days": with_map,
        "desired_days": desired or 14,
        "meets_target": recommended >= (desired or 14),
        "note": "Estimates combine commodity tables with barrier match, MAP and temperature offset. Validate with a real pack trial.",
    }


COST_INR_PER_M2 = {"Low": 12.0, "Medium": 28.0, "High": 55.0}


def cost_optimization(top_mats: list[dict], quantity_kg: Optional[float],
                      thickness_um: float) -> dict:
    qty = quantity_kg or 100.0
    area_m2 = max(1.0, qty * 0.08)
    rows = []
    for m in top_mats:
        tier = str(m.get("cost_tier", "Medium"))
        rate = COST_INR_PER_M2.get(tier, 28.0)
        gauge_factor = thickness_um / 40.0
        pack_cost = round(area_m2 * rate * gauge_factor, 0)
        per_kg = round(pack_cost / qty, 2)
        rows.append({
            "name": m.get("short_name"),
            "cost_tier": tier,
            "estimated_pack_inr": pack_cost,
            "inr_per_kg": per_kg,
            "rate_inr_per_m2": rate,
        })
    cheapest = min(rows, key=lambda r: r["estimated_pack_inr"]) if rows else None
    premium = max(rows, key=lambda r: r["estimated_pack_inr"]) if rows else None
    savings = 0
    if cheapest and premium:
        savings = round(premium["estimated_pack_inr"] - cheapest["estimated_pack_inr"], 0)
    return {
        "quantity_kg": qty,
        "assumed_film_area_m2": round(area_m2, 1),
        "options": rows,
        "lowest_cost_option": cheapest["name"] if cheapest else None,
        "potential_savings_inr": savings,
        "note": "Indicative film cost only (India MSME 2024–26 ranges). Convert, print and logistics extra.",
    }


def sustainability_analysis(top_mats: list[dict], prefer_eco: bool) -> dict:
    def score_one(m):
        s = 20
        if str(m.get("recyclable")).lower() == "yes":
            s += 30
        if str(m.get("biodegradable")).lower() == "yes":
            s += 35
        cat = str(m.get("category", ""))
        if "Paper" in cat or "Natural" in cat or "Biodegradable" in cat:
            s += 10
        if "Laminate" in cat or "Metallized" in cat:
            s -= 8
        return max(0, min(100, s))

    scored = [{"name": m.get("name"), "short_name": m.get("short_name"),
               "recyclable": m.get("recyclable"), "biodegradable": m.get("biodegradable"),
               "category": m.get("category"), "score": score_one(m)} for m in top_mats]
    primary = scored[0]["score"] if scored else 0

    ecos = []
    for _, row in materials_df.iterrows():
        if str(row.get("biodegradable")).lower() == "yes" or str(row.get("recyclable")).lower() == "yes":
            ecos.append({
                "name": row["name"],
                "short_name": row["short_name"],
                "biodegradable": row["biodegradable"],
                "recyclable": row["recyclable"],
                "cost_tier": row["cost_tier"],
            })
    ecos = ecos[:6]

    grade = "A" if primary >= 75 else "B" if primary >= 55 else "C" if primary >= 35 else "D"
    return {
        "primary_score": primary,
        "grade": grade,
        "ranked": scored,
        "eco_alternatives": ecos,
        "prefer_eco_applied": prefer_eco,
        "note": "Score weights recyclability and compostability. Food-safety barrier still outranks eco when they conflict.",
    }


def build_trace(commodity_name: str, rec: dict, specs: dict, inputs: dict) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    raw = f"{commodity_name}|{rec.get('short_name')}|{now}|{specs.get('required_otr')}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10].upper()
    pack_id = f"SPA-{digest}"
    payload = {
        "pack_id": pack_id,
        "system": "Smart Pack AI",
        "commodity": commodity_name,
        "material": rec.get("name"),
        "short_name": rec.get("short_name"),
        "thickness_um": rec.get("recommended_thickness", {}).get("recommended_um"),
        "storage": inputs.get("storage_type"),
        "issued_utc": now,
    }
    query = "&".join(f"{k}={v}" for k, v in payload.items() if v is not None)
    return {
        "pack_id": pack_id,
        "payload": payload,
        "qr_text": f"SMARTPACK|{pack_id}|{commodity_name}|{rec.get('short_name')}|{now}",
        "human_url": f"https://smartpack.local/trace?{query}",
    }


def fmt_material(score: float, mat: dict, mech: dict, inputs: dict, resp_class: str) -> dict:
    thick = recommend_thickness(mat, mech, int(inputs.get("shelf_life_days") or 14),
                                inputs.get("transport_mode") or "road")
    structure = packaging_structure(
        mat, resp_class, float(inputs.get("fat") or 0),
        float(inputs.get("moisture") or 70),
        bool(inputs.get("has_map_equipment")),
        inputs.get("storage_type") or "ambient",
    )
    return {
        "id": int(mat["id"]),
        "name": mat["name"],
        "short_name": mat["short_name"],
        "category": mat["category"],
        "score": score,
        "match_pct": int(min(100, round(score))),
        "otr_range": f"{mat['otr_min']}–{mat['otr_max']} cc/m²/day",
        "wvtr_range": f"{mat['wvtr_min']}–{mat['wvtr_max']} g/m²/day",
        "co2_range": f"{mat['co2_tr_min']}–{mat['co2_tr_max']} cc/m²/day",
        "thickness_range": f"{mat['thickness_min']}–{mat['thickness_max']} µm",
        "recommended_thickness": thick,
        "structure": structure,
        "biodegradable": mat["biodegradable"],
        "recyclable": mat["recyclable"],
        "heat_sealable": mat["heat_sealable"],
        "map_compatible": mat["map_compatible"],
        "cost_tier": mat["cost_tier"],
        "best_for": mat.get("best_for", ""),
        "avoid_for": mat.get("avoid_for", ""),
        "description": mat["description"],
        "color_barrier": mat.get("color_barrier", "No"),
        "uv_barrier": mat.get("uv_barrier", "No"),
        "mechanical": mech,
    }


def recommend(inputs: dict) -> dict:
    commodity = get_commodity_info(inputs.get("commodity", ""))

    if commodity:
        resp_class = str(commodity.get("respiration_rate_class", "Moderate"))
        moisture = _to_num(commodity.get("moisture_pct"), 70)
        fat = _to_num(commodity.get("fat_pct"), 1)
        ph_raw = commodity.get("ph", 6.0)
        ph = _to_num(ph_raw, 6.0)
        storage_type = (inputs.get("storage_type") or str(commodity.get("storage_type_default", "ambient"))).lower()
        category = str(commodity.get("category", ""))
    else:
        resp_class = inputs.get("respiration_class") or "Moderate"
        moisture = float(inputs.get("moisture", 70))
        fat = float(inputs.get("fat", 1))
        ph = float(inputs.get("ph", 6.0))
        storage_type = (inputs.get("storage_type") or "ambient").lower()
        category = ""

    if inputs.get("moisture") is not None:
        moisture = float(inputs["moisture"])
    if inputs.get("fat") is not None:
        fat = float(inputs["fat"])
    if inputs.get("ph") is not None:
        ph = float(inputs["ph"])
    if inputs.get("respiration_class"):
        resp_class = inputs["respiration_class"]

    temp_c = inputs.get("storage_temp_c")
    rh_pct = inputs.get("relative_humidity")
    if temp_c is not None:
        temp_c = float(temp_c)
    if rh_pct is not None:
        rh_pct = float(rh_pct)

    inputs = {**inputs, "moisture": moisture, "fat": fat, "ph": ph, "storage_type": storage_type}

    otr_req = determine_required_otr(resp_class, storage_type)
    wvtr_req = determine_required_wvtr(moisture, storage_type, rh_pct)
    co2_req = determine_required_co2tr(resp_class, storage_type)
    mech = mechanical_requirement(
        inputs.get("transport_mode") or "road",
        inputs.get("quantity_kg"),
        category,
        storage_type,
    )

    ml_scores = ml_similarity_scores(otr_req, wvtr_req)

    scored = []
    for _, row in materials_df.iterrows():
        mat = row.to_dict()
        rule = score_material(mat, otr_req, wvtr_req, co2_req, inputs, commodity, mech)
        ml = ml_scores.get(int(mat["id"]), rule)
        blended = round(0.72 * rule + 0.28 * ml, 2)
        scored.append((blended, mat))
    scored.sort(key=lambda x: x[0], reverse=True)

    recommendations = [fmt_material(s, m, mech, inputs, resp_class) for s, m in scored[:3]]
    eco_alts = []
    for s, m in scored:
        if str(m.get("biodegradable")).lower() == "yes" or str(m.get("recyclable")).lower() == "yes":
            if int(m["id"]) not in {r["id"] for r in recommendations}:
                eco_alts.append(fmt_material(s, m, mech, inputs, resp_class))
        if len(eco_alts) >= 3:
            break

    breathable = resp_class in ("Very High", "High") and storage_type != "frozen"

    specs = {
        "required_otr": {"min": otr_req[0], "max": otr_req[1], "unit": "cc/m²/day @ 23°C 50% RH", "note": otr_req[2]},
        "required_wvtr": {"min": wvtr_req[0], "max": wvtr_req[1], "unit": "g/m²/day @ 38°C 90% RH", "note": wvtr_req[2]},
        "required_co2tr": {"min": co2_req[0], "max": co2_req[1], "unit": "cc/m²/day", "note": co2_req[2]},
        "gas_permeability": "High (breathable)" if breathable else "Low (barrier)",
        "sealability": "Heat-seal recommended for leak-tight MAP and dry goods",
        "map_suitability": "Recommended" if (breathable or inputs.get("has_map_equipment")) else "Optional",
        "breathable_or_microperf": breathable,
        "respiration_class": resp_class,
        "moisture_class": (
            "Very High (>85%)" if moisture >= 85 else
            "High (60–85%)" if moisture >= 60 else
            "Moderate (20–60%)" if moisture >= 20 else "Low (<20%)"
        ),
        "fat_class": (
            "High fat (>20%)" if fat >= 20 else
            "Moderate fat (5–20%)" if fat >= 5 else "Low fat (<5%)"
        ),
        "ph_class": (
            "Highly Acidic (pH<3.5)" if ph < 3.5 else
            "Acidic (pH 3.5–5)" if ph < 5 else
            "Slightly Acidic (pH 5–6)" if ph < 6 else "Near Neutral / Neutral (pH 6+)"
        ),
        "mechanical": mech,
        "recommended_thickness_um": recommendations[0]["recommended_thickness"]["recommended_um"] if recommendations else None,
    }

    map_comp = get_map_composition(commodity, storage_type, resp_class)
    storage_guidelines = get_storage_guidelines(commodity, storage_type, inputs, temp_c, rh_pct)

    top = recommendations[0] if recommendations else {}
    shelf = predict_shelf_life(
        commodity, storage_type, int(inputs.get("shelf_life_days") or 14),
        float(top.get("match_pct") or 0),
        bool(inputs.get("has_map_equipment")),
        str(top.get("map_compatible")) == "Yes",
        temp_c,
        inputs.get("transport_hours"),
    )
    cost = cost_optimization(recommendations, inputs.get("quantity_kg"),
                             float(specs["recommended_thickness_um"] or 40))
    sustain = sustainability_analysis(recommendations, bool(inputs.get("prefer_eco")))
    trace = build_trace(inputs.get("commodity") or "Unknown", top, specs, inputs) if top else {}

    commodity_display = None
    if commodity:
        commodity_display = {
            "name": commodity.get("commodity"),
            "category": commodity.get("category"),
            "subcategory": commodity.get("subcategory"),
            "respiration_rate_class": commodity.get("respiration_rate_class"),
            "ethylene_producer": commodity.get("ethylene_producer"),
            "ethylene_sensitive": commodity.get("ethylene_sensitive"),
            "optimal_temp_c": commodity.get("optimal_temp_c"),
            "optimal_rh_pct": commodity.get("optimal_rh_pct"),
            "notes": commodity.get("notes"),
        }

    return {
        "success": True,
        "engine": "hybrid-rule+cosine",
        "commodity_info": commodity_display,
        "recommendations": recommendations,
        "eco_alternatives": eco_alts,
        "specs": specs,
        "map_composition": map_comp,
        "storage_guidelines": storage_guidelines,
        "shelf_life": shelf,
        "cost": cost,
        "sustainability": sustain,
        "traceability": trace,
        "inputs_used": {
            "moisture": moisture,
            "fat": fat,
            "ph": ph,
            "storage_type": storage_type,
            "respiration_class": resp_class,
            "storage_temp_c": temp_c,
            "relative_humidity": rh_pct,
            "transport_mode": inputs.get("transport_mode") or "road",
            "transport_hours": inputs.get("transport_hours"),
            "quantity_kg": inputs.get("quantity_kg"),
        },
    }


if __name__ == "__main__":
    import json
    test = recommend({
        "commodity": "Broccoli",
        "storage_type": "chilled",
        "prefer_eco": True,
        "cost_priority": "balanced",
        "has_map_equipment": True,
        "shelf_life_days": 14,
        "storage_temp_c": 2,
        "relative_humidity": 95,
        "transport_mode": "road",
        "transport_hours": 18,
        "quantity_kg": 250,
    })
    print(json.dumps(test, indent=2, default=str))
