# Smart Pack AI — Packhouse Console

Intelligent food packaging recommendation engine for agricultural commodities, fresh produce, dairy, meat, and processed foods.

## Features
- **Inputs**: Commodity, moisture, fat/oil, pH, respiration rate, shelf life target, storage type, temperature, RH, transport mode & duration, lot size, cost priority, eco preferences, MAP equipment availability.
- **Outputs**: Ranked packaging materials (LDPE, HDPE, PET, metallized films, foil laminates, biodegradable, breathable films), required OTR / WVTR / CO₂TR barrier windows, gauge/thickness optimization, mechanical requirements, pack structure & multilayer breakdown, MAP headspace gas mix, shelf-life prediction, film cost estimation, sustainability scoring, and QR lot traceability.
- **Tools**: Material comparison matrix, pack dimension & film calculator, lot verification lookup, and technical data sheets.

## Quick start (browser mode)
Open `app/frontend/index.html` directly in your browser for client-side processing.

## Full stack mode (Python Flask backend)
```bash
cd app/backend
pip install -r requirements.txt
python app.py
```
Backend API will run at `http://127.0.0.1:5000`.
Then open `app/frontend/index.html`.

