# lingo

Learn vocabulary in context: a fill-in-the-blank trainer for Swedish and Romanian.
It's a static, offline-capable web app (PWA) with no framework, no build step and no backend.

- `app/` is the web app. Deploy this folder as-is.
- `data-pipeline/` is the offline Python script that builds `app/data/*.json` from Tatoeba. See its [README](data-pipeline/README.md).

## How it plays

- **Lessons:** each lesson has 10 sentences: up to 8 due reviews (most overdue first) and at least 2 new ones. When fewer reviews are due, new sentences fill the rest.
- **Spacing:** a correct answer adds 1 to the sentence's counter, and the sentence comes back after that many calendar days (1, 2, 3…). A wrong answer resets the counter to 0, and the sentence is due again in the next lesson.
- **Order:** new sentences are introduced from easiest to hardest.
- **Your data:** progress lives in `localStorage` on the device. Use Settings to export or import a JSON backup.

## Run locally

```bash
python3 -m http.server 8000 --directory app
```

Then open http://localhost:8000. Service workers need `localhost` or HTTPS.

## Rebuild the data

```bash
python3 data-pipeline/build_dataset.py
```

## Deploy to GitHub Pages

1. In the repo settings, open **Pages** and set **Source** to **GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/pages.yml` publishes the `app/` folder.

**Releasing changes:** when you change any app or data file, bump `CACHE` in `app/sw.js` (for example `lingo-v1` to `lingo-v2`). Otherwise installed copies keep serving the cached version.

## Credits

Sentences come from [Tatoeba](https://tatoeba.org), licensed under [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/).
