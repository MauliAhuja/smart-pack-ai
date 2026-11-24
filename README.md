# Smart Pack AI v3.0 — Local ML Packaging Recommender

Smart Pack AI recommends food packaging for agricultural commodities, fresh produce, dairy, meat, and processed foods. It combines a fast local scikit-learn model with an optional Gemini API review.

The local model is a lightweight TF-IDF text-matching model. It ranks the material catalogue on the backend computer. When a Gemini key is configured, Gemini explains the top-ranked choice in plain language, including why it fits, a trade-off, and assumptions. It does not replace the local model's ranking or packaging constraints.

## What's New in v3.0

- **Local ML ranking**: A scikit-learn TF-IDF model compares product details with material descriptions and best-use/avoid-use text.
- **Gemini explanation**: With a key configured, Gemini explains the top-ranked local option in everyday words.
- **Graceful offline use**: Local recommendation scoring still works if no key is configured or Gemini is unavailable.
- **Packaging checks**: The model ranking is combined with barrier-property similarity and packaging constraints.

## Quick Start

### 1. Run the Flask backend

```bash
cd app/backend
python -m venv .venv
```

Activate the virtual environment (`.venv\Scripts\activate` on Windows, or `source .venv/bin/activate` on macOS/Linux), then install dependencies and start the API:

```bash
pip install -r requirements.txt
python app.py
```

To enable Gemini's second opinion, put your key in `app/backend/.env` as `GEMINI_API_KEY=your-key`. The local model works without this key.

The API runs at `http://127.0.0.1:5000`.

### 2. Run the frontend

Install Node.js, then run from the project root:

```bash
npm run dev
```

Open the local address printed by the command. The frontend can also be opened directly from `app/frontend/index.html`.

## Architecture

```
User → Frontend (HTML/JS) → Flask API (port 5000)
                                ↓
                    scikit-learn local model
                                ↓
                   Ranked packaging materials
```

## How It Works

1. User enters commodity details (name, storage type, transport, preferences).
2. The backend's local TF-IDF model compares product details against the materials catalogue text.
3. It combines text similarity with barrier-property similarity and packaging constraints to rank the materials.
4. The backend returns the ranking and supporting packaging information to the frontend.

## Files

| File | Purpose |
|------|---------|
| `app/backend/recommend.py` | Local scikit-learn TF-IDF ranker and packaging constraints |
| `app/backend/ai_engine.py` | Gemini shortlist review, enabled when an API key is configured |
| `app/backend/app.py` | Flask API server |
| `app/frontend/index.html` | Main UI |
| `app/frontend/app.js` | Frontend logic |
| `app/frontend/styles.css` | Styles |
| `app/backend/data/` | CSV databases (commodities + materials) |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Service status + AI engine info |
| `/api/recommend` | POST | **AI-powered** packaging recommendation |
| `/api/commodities` | GET | List all commodities |
| `/api/commodity/<name>` | GET | Single commodity detail |
| `/api/materials` | GET | List all materials |
