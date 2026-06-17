# Generátor reklamních bannerů

Automatizovaná pipeline pro generování reklamních bannerů ve více formátech.

1. **ČÁST A – AI Outpainting** – čtvercové referenční pozadí se přes Google
   GenAI rozšíří (outpainting) na poměr stran daného formátu.
2. **ČÁST B – Kompozice (Pillow)** – do rozšířeného pozadí se vloží logo a
   nadpis se zalamováním textu.

Podporované formáty: `300x250`, `728x90`, `160x600` (lze upravit v `main.py`).

---

## 1. Co si musíš připravit do složky `inputs/`

| Soubor | Popis | Doporučení |
|---|---|---|
| `inputs/background.jpg` | **Povinné.** Čtvercový referenční obrázek pozadí, ze kterého AI dokresluje okraje. | Ideálně 1024×1024 px, hlavní motiv (např. podání rukou) vycentrovaný, s prostorem kolem. |
| `inputs/logo.png` | Logo firmy s **průhledným pozadím**. | PNG s alfa kanálem. Vloží se na střed spodní hrany. |
| `inputs/font.ttf` | TrueType font pro nadpis. | Bezpatkový font firemní identity (`.ttf` nebo `.otf`). |

Pokud `logo.png` nebo `font.ttf` chybí, skript poběží dál (banner bez loga /
s vestavěným fontem). Bez `background.jpg` se skript zastaví.

---

## 2. Instalace

```bash
cd banner-generator

# 1) Vytvoř a aktivuj virtuální prostředí
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

# 2) Nainstaluj knihovny
pip install -r requirements.txt
```

---

## 3. API klíč pro Gemini

Klíč se načítá z proměnné prostředí `GEMINI_API_KEY` (alternativně
`GOOGLE_API_KEY`). Získáš ho v [Google AI Studio](https://aistudio.google.com/apikey).

```bash
export GEMINI_API_KEY="tvuj-api-klic"   # Windows: set GEMINI_API_KEY=...
```

> **Bez klíče** se Část A přepne na deterministický **Pillow fallback**
> (rozmazané roztažení okrajů). Pipeline tak funguje i offline – hodí se
> pro testování kompozice bez spotřeby kvóty.

---

## 4. Spuštění

```bash
python main.py
```

Výsledné bannery se uloží do `outputs/` jako `banner_300x250.jpg`,
`banner_728x90.jpg`, `banner_160x600.jpg`.

---

## Poznámka k výběru modelu

Pravý outpainting Imagenu (`edit_image` + `EDIT_MODE_OUTPAINT` s maskou) je
dostupný jen přes **Vertex AI**. Veřejné Gemini Developer API (přístup přes
API klíč) tento režim nemá, proto používáme obrazově-editační model
**`gemini-2.5-flash-image`**, který přijímá vstupní obrázek a dokreslí jeho
okolí. Model nevrací přesné rozměry, výstup proto srovnáváme na cílový
formát pomocí Pillow (cover + crop).
