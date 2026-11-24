# Smart Pack AI

Smart Pack AI recommends food packaging for agricultural commodities, fresh produce, dairy, meat, and processed foods.

## Run the frontend

Install Node.js, then run from the project root:

```bash
npm run dev
```

Open the local address printed by the command. The frontend can also be opened directly from `app/frontend/index.html`.

## Run the Flask backend

Install Python, then run:

```bash
cd app/backend
python -m venv .venv
```

Activate the virtual environment (`.venv\Scripts\activate` on Windows, or `source .venv/bin/activate` on macOS/Linux), then install dependencies and start the API:

```bash
pip install -r requirements.txt
python app.py
```

The API runs at `http://127.0.0.1:5000`.
