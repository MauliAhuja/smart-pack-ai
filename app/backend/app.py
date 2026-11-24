"""Smart Pack AI — Flask API with local scikit-learn recommendations."""

import os
from flask import Flask, request, jsonify
from flask_cors import CORS
import traceback
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# Use the local scikit-learn recommender by default. It needs no API key or network.
from recommend import recommend, list_commodities, list_materials, get_commodity_info
ENGINE = "local-tfidf-ml+constraints"

app = Flask(__name__)
CORS(app)


def error(msg, code=400):
    return jsonify({"success": False, "error": msg}), code


def validate_float(val, name, min_val=None, max_val=None):
    try:
        v = float(val)
        if min_val is not None and v < min_val:
            return None, f"{name} must be >= {min_val}"
        if max_val is not None and v > max_val:
            return None, f"{name} must be <= {max_val}"
        return v, None
    except (TypeError, ValueError):
        return None, f"{name} must be a valid number"


@app.route("/api/health", methods=["GET"])
def health():
    gemini_key_set = bool(os.getenv("GEMINI_API_KEY"))
    return jsonify({
        "status": "ok",
        "service": "Smart Pack AI",
        "version": "3.0.0",
        "engine": ENGINE,
        "ai_enabled": True,
        "model": "scikit-learn TF-IDF + cosine similarity",
        "gemini_review_enabled": gemini_key_set,
    })


@app.route("/api/recommend", methods=["POST"])
def api_recommend():
    data = request.get_json(force=True, silent=True)
    if not data:
        return error("Request body must be JSON")

    commodity = str(data.get("commodity", "")).strip()
    storage_type = str(data.get("storage_type", "ambient")).strip().lower()
    if storage_type not in ("ambient", "chilled", "frozen"):
        return error("storage_type must be 'ambient', 'chilled', or 'frozen'")

    transport = str(data.get("transport_mode", "road")).strip().lower().replace(" ", "-")
    if transport in ("last_mile", "lastmile"):
        transport = "last-mile"
    if transport not in ("road", "rail", "air", "sea", "last-mile"):
        transport = "road"

    inputs = {
        "commodity": commodity,
        "storage_type": storage_type,
        "prefer_eco": bool(data.get("prefer_eco", False)),
        "cost_priority": data.get("cost_priority", "balanced"),
        "has_map_equipment": bool(data.get("has_map_equipment", False)),
        "shelf_life_days": data.get("shelf_life_days", 14),
        "respiration_class": data.get("respiration_class", ""),
        "quantity_kg": data.get("quantity_kg", None),
        "transport_mode": transport,
        "transport_hours": data.get("transport_hours", None),
        "storage_temp_c": data.get("storage_temp_c", None),
        "relative_humidity": data.get("relative_humidity", None),
    }

    for field, min_v, max_v in [
        ("moisture", 0, 100),
        ("fat", 0, 100),
        ("ph", 0, 14),
        ("storage_temp_c", -30, 45),
        ("relative_humidity", 0, 100),
        ("quantity_kg", 0.1, 1_000_000),
        ("transport_hours", 0, 2000),
        ("shelf_life_days", 1, 3650),
    ]:
        if data.get(field) is not None and data.get(field) != "":
            v, err = validate_float(data[field], field, min_v, max_v)
            if err:
                return error(err)
            inputs[field] = v

    try:
        result = recommend(inputs)
        # The local model always creates the shortlist. Gemini optionally reviews it.
        if os.getenv("GEMINI_API_KEY"):
            try:
                from ai_engine import review_local_recommendation
                result = review_local_recommendation(result, inputs)
            except Exception:
                traceback.print_exc()
        return jsonify(result)
    except Exception:
        traceback.print_exc()
        return error("Recommendation engine error. Please check your inputs.", 500)


@app.route("/api/commodities", methods=["GET"])
def api_commodities():
    q = request.args.get("q", "").lower()
    items = list_commodities()
    if q:
        items = [i for i in items if q in str(i.get("commodity", "")).lower()]
    return jsonify({"success": True, "data": items, "count": len(items)})


@app.route("/api/commodity/<name>", methods=["GET"])
def api_commodity_detail(name):
    info = get_commodity_info(name)
    if not info:
        return error(f"Commodity '{name}' not found in database", 404)
    clean = {}
    for k, v in info.items():
        if v is None:
            clean[k] = None
        else:
            s = str(v)
            clean[k] = None if s.lower() == "nan" else v
    return jsonify({"success": True, "data": clean})


@app.route("/api/materials", methods=["GET"])
def api_materials():
    items = list_materials()
    category = request.args.get("category", "").lower()
    if category:
        items = [i for i in items if category in str(i.get("category", "")).lower()]
    return jsonify({"success": True, "data": items, "count": len(items)})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
