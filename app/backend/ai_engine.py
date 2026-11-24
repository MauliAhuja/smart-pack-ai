"""
Smart Pack AI — Optional Gemini review for local ML recommendations.
The default app ranks materials locally, then uses Gemini to review that shortlist.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Optional

try:
    import google.generativeai as genai
except ImportError:
    genai = None

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Data loading (same CSVs as before — cached in memory)
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# Gemini setup — lazy initialisation so the app starts even without a key
# ---------------------------------------------------------------------------
_MODEL = None
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")


def _get_model():
    global _MODEL
    if _MODEL is None:
        if genai is None:
            return None
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            return None
        genai.configure(api_key=api_key)
        _MODEL = genai.GenerativeModel(
            GEMINI_MODEL,
            generation_config={
                "temperature": 0.3,          # low temp → deterministic
                "max_output_tokens": 4096,
                "response_mime_type": "application/json",
            },
        )
    return _MODEL


def review_local_recommendation(result: dict, inputs: dict) -> dict:
    """Ask Gemini to review only the local model's shortlisted materials."""
    model = _get_model()
    candidates = result.get("recommendations", [])
    if not model or not candidates:
        return result

    shortlist = [{
        "id": item.get("id"),
        "name": item.get("name"),
        "match_pct": item.get("match_pct"),
        "best_for": item.get("best_for"),
        "avoid_for": item.get("avoid_for"),
        "otr_range": item.get("otr_range"),
        "wvtr_range": item.get("wvtr_range"),
        "cost_tier": item.get("cost_tier"),
    } for item in candidates]
    prompt = f"""You are explaining a packaging recommendation to a non-technical user.
The local model has already ranked the shortlist. Explain its first-ranked material; do not
change the ranking or recommend a different candidate. selected_material_id must equal the
ID of the first candidate in the supplied list.
Return JSON with these fields:
- selected_material_id: integer from the shortlist
- recommendation: one simple sentence naming what you recommend
- why_it_fits: two or three short sentences explaining why it fits this product and conditions
- tradeoff: one short sentence about a real drawback from the supplied data; if none is listed,
  say that the catalogue does not provide enough information to compare drawbacks
- assumptions: one short sentence stating important missing information or assumptions

Use everyday words. Explain any technical term you need to use. Refer only to supplied facts;
do not make up shelf-life, safety, performance, or cost claims. The match_pct is a relative
ranking score, not a probability or guarantee. If the data does not support a claim, say so.

Product and conditions: {json.dumps(inputs, ensure_ascii=False)}
Candidates: {json.dumps(shortlist, ensure_ascii=False)}
"""
    try:
        response = model.generate_content(prompt)
        text = response.text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        review = json.loads(text)
        selected_id = int(review.get("selected_material_id"))
        selected = next((item for item in candidates if int(item.get("id", -1)) == selected_id), None)
        if not selected or selected_id != int(candidates[0].get("id", -1)):
            return result
        result["gemini_review"] = {
            "selected_material_id": selected_id,
            "selected_material_name": selected.get("name"),
            "recommendation": str(review.get("recommendation", ""))[:500],
            "why_it_fits": str(review.get("why_it_fits", ""))[:1000],
            "tradeoff": str(review.get("tradeoff", ""))[:500],
            "assumptions": str(review.get("assumptions", ""))[:500],
        }
        result["engine"] = "local-tfidf-ml+gemini-review"
    except Exception as exc:
        print(f"[Gemini review] unavailable: {exc}")
    return result


# ---------------------------------------------------------------------------
# Build the Gemini prompt  — the LLM does ALL the thinking
# ---------------------------------------------------------------------------
def _build_materials_summary() -> str:
    """Compact text table of every material in the database."""
    rows = []
    for _, m in materials_df.iterrows():
        rows.append(
            f"id={m['id']} | {m['name']} ({m['short_name']}) | cat={m['category']} | "
            f"OTR={m['otr_min']}-{m['otr_max']} | WVTR={m['wvtr_min']}-{m['wvtr_max']} | "
            f"CO2TR={m['co2_tr_min']}-{m['co2_tr_max']} | "
            f"thick={m['thickness_min']}-{m['thickness_max']}µm | "
            f"MAP={m.get('map_compatible','No')} | seal={m.get('heat_sealable','No')} | "
            f"bio={m.get('biodegradable','No')} | recycle={m.get('recyclable','No')} | "
            f"cost={m.get('cost_tier','Medium')} | best_for={m.get('best_for','')} | "
            f"avoid_for={m.get('avoid_for','')} | desc={m.get('description','')}"
        )
    return "\n".join(rows)


@lru_cache(maxsize=1)
def _materials_text() -> str:
    return _build_materials_summary()


def _get_commodity_row(name: str) -> Optional[dict]:
    if not name:
        return None
    n = name.strip().lower()
    match = commodities_df[commodities_df["commodity"].str.lower() == n]
    if not match.empty:
        return match.iloc[0].to_dict()
    match = commodities_df[commodities_df["commodity"].str.lower().str.contains(n, regex=False)]
    if not match.empty:
        return match.iloc[0].to_dict()
    return None


def _build_prompt(inputs: dict, commodity: Optional[dict]) -> str:
    """The single mega-prompt that asks Gemini to do EVERYTHING."""
    commodity_text = json.dumps(commodity, indent=2, default=str) if commodity else "No commodity data found in database. Use the user-provided values below."

    return f"""You are a world-class food packaging scientist and engineer.
You have deep expertise in barrier engineering, Modified Atmosphere Packaging (MAP),
shelf life science, ASTM/ISO test standards, sustainability, and cost economics.

=== AVAILABLE PACKAGING MATERIALS DATABASE ===
{_materials_text()}

=== COMMODITY / PRODUCT DATA ===
{commodity_text}

=== USER INPUTS ===
{json.dumps(inputs, indent=2, default=str)}

=== YOUR TASK ===
Analyze the commodity's properties (moisture, fat, pH, respiration rate, storage type,
temperature, humidity, transport mode) against EVERY material in the database.

Pick the TOP 3 best packaging materials (ranked by suitability) and up to 3 eco-friendly
alternatives (biodegradable or recyclable) that are NOT already in the top 3.

For EACH recommended material, determine:
1. A match score (0–100) based on how well the material's barrier properties
   (OTR, WVTR, CO₂TR), mechanical strength, cost tier, eco profile, and
   application suitability match the commodity's needs.
2. The ideal thickness (in µm) within the material's range.
3. A concise technical justification (2–3 sentences).

Also determine:
- Required OTR range (min, max in cc/m²/day) with a note explaining why
- Required WVTR range (min, max in g/m²/day) with a note explaining why
- Required CO₂TR range (min, max in cc/m²/day) with a note explaining why
- Moisture class, fat class, pH class, respiration class
- Gas permeability requirement (High breathable or Low barrier)
- MAP suitability (Recommended / Optional / Not needed)
- Mechanical requirements (puncture, tensile, flex — each High/Medium/Low) with note
- Recommended MAP gas composition (O2%, CO2%, N2%) with note
- Storage guidelines (temperature, humidity, light, transport, special notes)
- Shelf life prediction (unpackaged_days, basic_pack_days, recommended_pack_days,
  map_pack_days) relative to target {inputs.get('shelf_life_days', 14)} days
- Cost analysis for each top material (estimated INR per lot at ₹12/m² Low, ₹28/m² Medium, ₹55/m² High)
- Sustainability score (0-100) and grade (A/B/C/D) for each top material
- A comprehensive AI explanation paragraph (150–250 words) explaining the
  overall recommendation strategy, trade-offs, and key considerations

Return your answer as a single JSON object with this exact structure:
{{
  "ai_explanation": "string — 150-250 word comprehensive explanation of the recommendation",
  "recommendations": [
    {{
      "id": int,
      "name": "string",
      "short_name": "string",
      "category": "string",
      "match_pct": int (0-100),
      "recommended_thickness_um": int,
      "justification": "string — 2-3 sentence technical justification"
    }}
  ],
  "eco_alternatives": [
    {{
      "id": int,
      "name": "string",
      "short_name": "string",
      "category": "string",
      "match_pct": int,
      "recommended_thickness_um": int,
      "justification": "string"
    }}
  ],
  "required_otr": {{"min": float, "max": float, "note": "string"}},
  "required_wvtr": {{"min": float, "max": float, "note": "string"}},
  "required_co2tr": {{"min": float, "max": float, "note": "string"}},
  "moisture_class": "string",
  "fat_class": "string",
  "ph_class": "string",
  "respiration_class": "string",
  "gas_permeability": "string — High (breathable) or Low (barrier)",
  "map_suitability": "string — Recommended / Optional / Not needed",
  "mechanical": {{
    "puncture_resistance": "High/Medium/Low",
    "tensile_strength": "High/Medium/Low",
    "flex_crack_resistance": "High/Medium/Low",
    "note": "string"
  }},
  "map_composition": {{"O2": int, "CO2": int, "N2": int, "note": "string"}},
  "storage_guidelines": {{
    "temperature": "string",
    "relative_humidity": "string",
    "light_exposure": "string",
    "transport": "string",
    "shelf_life_estimate": "string",
    "special_notes": ["string"]
  }},
  "shelf_life": {{
    "unpackaged_days": int,
    "basic_pack_days": int,
    "recommended_pack_days": int,
    "map_pack_days": int,
    "desired_days": int,
    "meets_target": bool,
    "note": "string"
  }},
  "sustainability": [
    {{"short_name": "string", "score": int, "grade": "string", "recyclable": "Yes/No", "biodegradable": "Yes/No"}}
  ],
  "cost_analysis": [
    {{"short_name": "string", "cost_tier": "string", "estimated_pack_inr": int, "inr_per_kg": float}}
  ]
}}

IMPORTANT: Return ONLY the JSON object, no markdown, no code fences, no extra text.
"""


# ---------------------------------------------------------------------------
# Main recommend function — calls Gemini, parses, enriches
# ---------------------------------------------------------------------------
COST_INR_PER_M2 = {"Low": 12.0, "Medium": 28.0, "High": 55.0}


def _enrich_material(ai_rec: dict, inputs: dict) -> dict:
    """Merge the AI-picked material info with the full DB row."""
    mat_id = ai_rec.get("id")
    row = materials_df[materials_df["id"] == mat_id]
    if row.empty:
        # Fallback: try matching by short_name
        row = materials_df[materials_df["short_name"] == ai_rec.get("short_name")]
    if row.empty:
        return ai_rec  # can't enrich

    m = row.iloc[0]
    rec_um = ai_rec.get("recommended_thickness_um", int((m["thickness_min"] + m["thickness_max"]) / 2))

    return {
        "id": int(m["id"]),
        "name": str(m["name"]),
        "short_name": str(m["short_name"]),
        "category": str(m["category"]),
        "score": float(ai_rec.get("match_pct", 70)),
        "match_pct": int(ai_rec.get("match_pct", 70)),
        "otr_range": f"{m['otr_min']}–{m['otr_max']} cc/m²/day",
        "wvtr_range": f"{m['wvtr_min']}–{m['wvtr_max']} g/m²/day",
        "co2_range": f"{m['co2_tr_min']}–{m['co2_tr_max']} cc/m²/day",
        "thickness_range": f"{m['thickness_min']}–{m['thickness_max']} µm",
        "recommended_thickness": {
            "recommended_um": rec_um,
            "range_um": [float(m["thickness_min"]), float(m["thickness_max"])],
            "note": f"AI recommends {rec_um} µm within the {int(m['thickness_min'])}–{int(m['thickness_max'])} µm window",
        },
        "structure": _build_structure(m, inputs),
        "biodegradable": str(m.get("biodegradable", "No")),
        "recyclable": str(m.get("recyclable", "No")),
        "heat_sealable": str(m.get("heat_sealable", "No")),
        "map_compatible": str(m.get("map_compatible", "No")),
        "cost_tier": str(m.get("cost_tier", "Medium")),
        "best_for": str(m.get("best_for", "")),
        "avoid_for": str(m.get("avoid_for", "")),
        "description": str(m.get("description", "")),
        "color_barrier": str(m.get("color_barrier", "No")),
        "uv_barrier": str(m.get("uv_barrier", "No")),
        "justification": ai_rec.get("justification", ""),
        "mechanical": {},
    }


def _build_structure(m, inputs: dict) -> dict:
    """Build a simple pack structure description from the material."""
    short = str(m.get("short_name", ""))
    cat = str(m.get("category", ""))
    storage = inputs.get("storage_type", "ambient")

    if "Breathable" in cat or short in ("Micro-PP", "AF-PP"):
        form = "Micro-perforated pillow pouch"
        layers = [
            {"layer": "Outer print", "material": "PP / AF-PP", "role": "Graphics, anti-fog"},
            {"layer": "Laser perforations", "material": short, "role": "Controlled O₂/CO₂ exchange"},
        ]
    elif "MAP" in cat or str(m.get("map_compatible")) == "Yes":
        form = "MAP tray + lidding film" if storage != "frozen" else "MAP pouch"
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
        layers = [{"layer": "Primary", "material": short, "role": "Containment + breathability"}]
    else:
        form = "Monolayer film pouch or overwrap"
        layers = [{"layer": "Primary film", "material": short, "role": "Barrier + seal"}]

    return {
        "pack_format": form,
        "structure_type": "Multilayer" if len(layers) > 1 else "Monolayer",
        "layers": layers,
        "seal_type": "Heat seal" if str(m.get("heat_sealable")) == "Yes" else "Mechanical / sew / clip",
        "map_suitability": str(m.get("map_compatible")),
    }


def _build_trace(commodity_name: str, rec: dict, inputs: dict) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    raw = f"{commodity_name}|{rec.get('short_name')}|{now}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10].upper()
    pack_id = f"SPA-{digest}"
    payload = {
        "pack_id": pack_id,
        "system": "Smart Pack AI — Gemini Engine",
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


def recommend(inputs: dict) -> dict:
    """
    Pure AI recommendation.
    Sends the commodity data + materials database to Gemini 1.5-flash,
    gets back a full structured recommendation, then enriches it with
    DB row details for the frontend.
    """
    commodity_name = inputs.get("commodity", "").strip()
    commodity = _get_commodity_row(commodity_name)

    # Resolve defaults from commodity row
    if commodity:
        inputs.setdefault("moisture", _to_num(commodity.get("moisture_pct"), 70))
        inputs.setdefault("fat", _to_num(commodity.get("fat_pct"), 1))
        inputs.setdefault("ph", _to_num(commodity.get("ph"), 6.0))
        if not inputs.get("respiration_class"):
            inputs["respiration_class"] = str(commodity.get("respiration_rate_class", "Moderate"))
        inputs.setdefault("storage_type", str(commodity.get("storage_type_default", "ambient")).lower())
    else:
        inputs.setdefault("moisture", 70)
        inputs.setdefault("fat", 1)
        inputs.setdefault("ph", 6.0)
        inputs.setdefault("respiration_class", "Moderate")
        inputs.setdefault("storage_type", "ambient")

    storage_type = inputs.get("storage_type", "ambient")

    # --- Call Gemini ---
    model = _get_model()
    ai_result = None

    if model:
        try:
            prompt = _build_prompt(inputs, commodity)
            response = model.generate_content(prompt)
            text = response.text.strip()
            # Clean any markdown fences
            if text.startswith("```"):
                text = re.sub(r"^```(?:json)?\s*", "", text)
                text = re.sub(r"\s*```$", "", text)
            ai_result = json.loads(text)
        except Exception as e:
            print(f"[AI ENGINE] Gemini call failed: {e}")
            ai_result = None

    # --- If Gemini fails or no key, return a minimal fallback ---
    if not ai_result:
        return _fallback_recommend(inputs, commodity)

    # --- Enrich recommendations with full DB data ---
    recs = []
    for ai_rec in ai_result.get("recommendations", [])[:3]:
        recs.append(_enrich_material(ai_rec, inputs))

    eco_alts = []
    for ai_rec in ai_result.get("eco_alternatives", [])[:3]:
        enriched = _enrich_material(ai_rec, inputs)
        if enriched.get("id") not in {r.get("id") for r in recs}:
            eco_alts.append(enriched)

    # Assign mechanical to each rec
    mech = ai_result.get("mechanical", {
        "puncture_resistance": "Medium",
        "tensile_strength": "Medium",
        "flex_crack_resistance": "Medium",
        "note": "Standard handling",
    })
    for r in recs:
        r["mechanical"] = mech
    for r in eco_alts:
        r["mechanical"] = mech

    top = recs[0] if recs else {}

    # Build specs
    otr = ai_result.get("required_otr", {"min": 10, "max": 1000, "note": "AI-determined"})
    wvtr = ai_result.get("required_wvtr", {"min": 1, "max": 20, "note": "AI-determined"})
    co2 = ai_result.get("required_co2tr", {"min": 1, "max": 500, "note": "AI-determined"})

    specs = {
        "required_otr": {**otr, "unit": "cc/m²/day @ 23°C 50% RH"},
        "required_wvtr": {**wvtr, "unit": "g/m²/day @ 38°C 90% RH"},
        "required_co2tr": {**co2, "unit": "cc/m²/day"},
        "gas_permeability": ai_result.get("gas_permeability", "Low (barrier)"),
        "sealability": "Heat-seal recommended for leak-tight MAP and dry goods",
        "map_suitability": ai_result.get("map_suitability", "Optional"),
        "breathable_or_microperf": "High" in ai_result.get("gas_permeability", ""),
        "respiration_class": ai_result.get("respiration_class", inputs.get("respiration_class", "Moderate")),
        "moisture_class": ai_result.get("moisture_class", "Moderate"),
        "fat_class": ai_result.get("fat_class", "Low fat (<5%)"),
        "ph_class": ai_result.get("ph_class", "Near Neutral"),
        "mechanical": mech,
        "recommended_thickness_um": top.get("recommended_thickness", {}).get("recommended_um"),
    }

    # Shelf life
    shelf = ai_result.get("shelf_life", {
        "unpackaged_days": 3,
        "basic_pack_days": 7,
        "recommended_pack_days": 14,
        "map_pack_days": 18,
        "desired_days": inputs.get("shelf_life_days", 14),
        "meets_target": True,
        "note": "AI-estimated shelf life. Confirm with a real pack trial.",
    })
    shelf.setdefault("desired_days", inputs.get("shelf_life_days", 14))
    shelf.setdefault("note", "AI-estimated shelf life. Confirm with a real pack trial.")

    # MAP
    map_comp = ai_result.get("map_composition", {"O2": 5, "CO2": 10, "N2": 85, "note": "AI-determined MAP recipe"})

    # Storage
    storage_guidelines = ai_result.get("storage_guidelines", {
        "temperature": "Per commodity optimum",
        "relative_humidity": "85–95% RH",
        "light_exposure": "Avoid direct sunlight and UV",
        "transport": f"{inputs.get('transport_mode', 'road')} · ~{inputs.get('transport_hours', 12)} h",
        "shelf_life_estimate": "",
        "special_notes": [],
    })

    # Cost
    qty = inputs.get("quantity_kg") or 100
    area = max(1.0, qty * 0.08)
    cost_rows = ai_result.get("cost_analysis", [])
    if not cost_rows:
        for r in recs:
            tier = r.get("cost_tier", "Medium")
            rate = COST_INR_PER_M2.get(tier, 28.0)
            gauge_factor = (r.get("recommended_thickness", {}).get("recommended_um", 40)) / 40.0
            pack_cost = round(area * rate * gauge_factor, 0)
            cost_rows.append({
                "name": r.get("short_name"),
                "short_name": r.get("short_name"),
                "cost_tier": tier,
                "estimated_pack_inr": pack_cost,
                "inr_per_kg": round(pack_cost / qty, 2),
            })
    else:
        for cr in cost_rows:
            cr.setdefault("name", cr.get("short_name", ""))

    cheapest = min(cost_rows, key=lambda r: r.get("estimated_pack_inr", 0)) if cost_rows else None
    premium = max(cost_rows, key=lambda r: r.get("estimated_pack_inr", 0)) if cost_rows else None
    savings = round(premium["estimated_pack_inr"] - cheapest["estimated_pack_inr"], 0) if cheapest and premium else 0

    cost = {
        "quantity_kg": qty,
        "assumed_film_area_m2": round(area, 1),
        "options": cost_rows,
        "lowest_cost_option": cheapest["short_name"] if cheapest else None,
        "potential_savings_inr": savings,
        "note": "AI-estimated film cost (India MSME 2024–26 ranges). Convert, print and logistics extra.",
    }

    # Sustainability
    sustain_list = ai_result.get("sustainability", [])
    if sustain_list:
        primary_score = sustain_list[0].get("score", 50) if sustain_list else 50
        grade = sustain_list[0].get("grade", "C") if sustain_list else "C"
    else:
        primary_score = 50
        grade = "C"

    sustainability = {
        "primary_score": primary_score,
        "grade": grade,
        "ranked": sustain_list if sustain_list else [{"short_name": r.get("short_name"), "score": 50, "recyclable": r.get("recyclable"), "biodegradable": r.get("biodegradable")} for r in recs],
        "eco_alternatives": eco_alts,
        "prefer_eco_applied": bool(inputs.get("prefer_eco")),
        "note": "AI-scored sustainability based on recyclability, compostability, and material category.",
    }

    # Traceability
    trace = _build_trace(commodity_name or "Unknown", top, inputs) if top else {}

    # Commodity display
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
        "engine": f"{GEMINI_MODEL}-ai",
        "ai_explanation": ai_result.get("ai_explanation", ""),
        "commodity_info": commodity_display,
        "recommendations": recs,
        "eco_alternatives": eco_alts,
        "specs": specs,
        "map_composition": map_comp,
        "storage_guidelines": storage_guidelines,
        "shelf_life": shelf,
        "cost": cost,
        "sustainability": sustainability,
        "traceability": trace,
        "inputs_used": {
            "moisture": inputs.get("moisture"),
            "fat": inputs.get("fat"),
            "ph": inputs.get("ph"),
            "storage_type": storage_type,
            "respiration_class": inputs.get("respiration_class"),
            "storage_temp_c": inputs.get("storage_temp_c"),
            "relative_humidity": inputs.get("relative_humidity"),
            "transport_mode": inputs.get("transport_mode", "road"),
            "transport_hours": inputs.get("transport_hours"),
            "quantity_kg": inputs.get("quantity_kg"),
        },
    }


# ---------------------------------------------------------------------------
# Fallback  — in case Gemini is unreachable (no key, quota, network)
# This imports the old rule engine so the app never breaks.
# ---------------------------------------------------------------------------
def _fallback_recommend(inputs: dict, commodity: Optional[dict]) -> dict:
    """Import the original recommend.py as fallback."""
    try:
        from recommend import recommend as rule_recommend
        result = rule_recommend(inputs)
        result["engine"] = "rule-fallback (Gemini unavailable)"
        result["ai_explanation"] = (
            "AI engine is currently unavailable (no API key or network issue). "
            "This recommendation was generated using the built-in rule-based engine. "
            "Set the GEMINI_API_KEY environment variable to enable AI-powered recommendations."
        )
        return result
    except Exception as e:
        return {
            "success": False,
            "error": f"Both AI engine and rule fallback failed: {e}",
            "engine": "none",
        }


# ---------------------------------------------------------------------------
# Helper functions for the Flask API (same interface as old recommend.py)
# ---------------------------------------------------------------------------
def get_commodity_info(commodity_name: str) -> Optional[dict]:
    return _get_commodity_row(commodity_name)


def list_commodities():
    cols = [
        "commodity", "category", "subcategory", "moisture_pct", "fat_pct", "ph",
        "respiration_rate_class", "storage_type_default", "optimal_temp_c",
        "optimal_rh_pct", "ethylene_producer", "ethylene_sensitive",
    ]
    present = [c for c in cols if c in commodities_df.columns]
    records = commodities_df[present].to_dict(orient="records")
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


def list_materials():
    records = materials_df.to_dict(orient="records")
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


# ---------------------------------------------------------------------------
if __name__ == "__main__":
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
