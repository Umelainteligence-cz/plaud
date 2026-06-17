"""
Automatizovaný generátor reklamních bannerů
===========================================

Pipeline má dvě hlavní části:

  ČÁST A – AI Outpainting modul
      Vezme čtvercový referenční obrázek (inputs/background.jpg) a pomocí
      Google GenAI (model "gemini-2.5-flash-image") rozšíří jeho okraje
      (outpainting) na cílový poměr stran banneru.

  ČÁST B – Kompoziční modul (Layout engine přes Pillow)
      Do rozšířeného pozadí vloží firemní identitu – logo a nadpis
      se zalamováním textu (word wrap).

Pozn. k API:
  Pravý "outpainting" Imagenu (client.models.edit_image s EDIT_MODE_OUTPAINT
  a maskou) je dostupný POUZE přes Vertex AI. Veřejné Gemini Developer API
  (přístup přes jednoduchý API klíč z proměnné prostředí) tento režim nemá,
  proto zde používáme obrazově-editační model "gemini-2.5-flash-image",
  který přijímá vstupní obrázek a umí dokreslit (rozšířit) jeho okolí.

  Pokud API klíč chybí nebo volání selže, automaticky se použije
  deterministický Pillow fallback (rozmazané roztažení okrajů). Díky tomu
  jde celý kompoziční řetězec otestovat i offline / bez spotřeby kvóty.
"""

from __future__ import annotations

import io
import os
import sys
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# --------------------------------------------------------------------------- #
#  KONFIGURACE
# --------------------------------------------------------------------------- #

# Cesty k souborům (relativně ke složce skriptu, ne k aktuálnímu adresáři).
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_DIR = os.path.join(BASE_DIR, "inputs")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")

BACKGROUND_PATH = os.path.join(INPUT_DIR, "background.jpg")
LOGO_PATH = os.path.join(INPUT_DIR, "logo.png")
FONT_PATH = os.path.join(INPUT_DIR, "font.ttf")

# Firemní barvy mageXo.
ORANGE = (255, 103, 0)          # #ff6700 – akcentová oranžová
TEXT_COLOR = (26, 26, 26)       # tmavě šedá pro nadpis (dobrá čitelnost na světlém pozadí)

# Nadpis vykreslený do banneru.
HEADLINE = "AI agenti pro váš e-shop"

# Outpainting model (Gemini Developer API, funguje s API klíčem z prostředí).
IMAGE_MODEL = "gemini-2.5-flash-image"

# Ochranný okraj (safe zone) po stranách textu i pro logo – v pixelech.
SAFE_MARGIN = 20

# Požadované formáty bannerů.
FORMATS = [
    {"w": 300, "h": 250},
    {"w": 728, "h": 90},
    {"w": 160, "h": 600},
]


# --------------------------------------------------------------------------- #
#  ČÁST A – AI OUTPAINTING MODUL
# --------------------------------------------------------------------------- #

def _get_genai_client():
    """Vytvoří klienta Google GenAI z API klíče v proměnných prostředí.

    Klíč hledáme v GEMINI_API_KEY i GOOGLE_API_KEY. Pokud není k dispozici
    knihovna nebo klíč, vrátíme None a pipeline použije Pillow fallback.
    """
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("  [AI] API klíč nenalezen (GEMINI_API_KEY/GOOGLE_API_KEY) – použiji fallback.")
        return None
    try:
        from google import genai  # import až tady, ať skript funguje i bez knihovny
        return genai.Client(api_key=api_key)
    except Exception as exc:  # noqa: BLE001 – chceme zachytit cokoliv a spadnout do fallbacku
        print(f"  [AI] Klienta se nepodařilo vytvořit ({exc}) – použiji fallback.")
        return None


def _build_outpaint_canvas(source: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Připraví plátno cílového poměru stran se zdrojovým obrázkem uprostřed.

    Zdroj zvětšíme/zmenšíme tak, aby plně vyplnil ten rozměr, který je u
    cílového formátu "těsnější", a vycentrujeme ho. Vzniklé prázdné okraje
    pak nechá AI dokreslit (outpainting). Pracujeme ve vyšším rozlišení,
    aby měl model dost detailu; finální zmenšení na přesné rozměry řeší až
    funkce ai_outpaint().
    """
    # Normalizační rozlišení "těsnější" osy – kompromis mezi kvalitou a rychlostí.
    base = 1024
    ratio = target_w / target_h

    if ratio >= 1:
        # Širší než vyšší → zdroj nastavíme na výšku plátna, rozšiřujeme do stran.
        canvas_h = base
        canvas_w = round(base * ratio)
        src_size = canvas_h
    else:
        # Vyšší než širší → zdroj nastavíme na šířku plátna, rozšiřujeme nahoru/dolů.
        canvas_w = base
        canvas_h = round(base / ratio)
        src_size = canvas_w

    # Neutrální plátno – průměrná barva zdroje pomáhá modelu i fallbacku se "chytit".
    fill = _average_color(source)
    canvas = Image.new("RGB", (canvas_w, canvas_h), fill)

    resized = source.resize((src_size, src_size), Image.LANCZOS)
    offset = ((canvas_w - src_size) // 2, (canvas_h - src_size) // 2)
    canvas.paste(resized, offset)
    return canvas


def _average_color(img: Image.Image) -> tuple[int, int, int]:
    """Vrátí průměrnou barvu obrázku (použito jako výplň prázdných okrajů)."""
    small = img.convert("RGB").resize((1, 1), Image.LANCZOS)
    return small.getpixel((0, 0))


def _fallback_extend(source: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Deterministické rozšíření pozadí bez AI.

    Vytvoří podklad roztažením a rozmazáním zdroje (vyplní celý formát) a
    do středu vloží ostrý originál. Není to "chytrý" outpainting, ale dává
    vizuálně použitelný a předvídatelný výsledek pro testování pipeline.
    """
    # Rozmazané pozadí přes celý formát (cover – ořízne, ať nezůstanou prázdná místa).
    bg = _resize_cover(source, target_w, target_h).filter(ImageFilter.GaussianBlur(24))

    # Ostrý originál vycentrovaný tak, aby vyplnil těsnější osu.
    if target_w / target_h >= 1:
        src_size = target_h
    else:
        src_size = target_w
    sharp = source.resize((src_size, src_size), Image.LANCZOS)
    offset = ((target_w - src_size) // 2, (target_h - src_size) // 2)
    bg.paste(sharp, offset)
    return bg


def _resize_cover(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Zmenší/zvětší obrázek tak, aby pokryl cílové rozměry, a ořízne přebytek."""
    src_w, src_h = img.size
    scale = max(target_w / src_w, target_h / src_h)
    new_size = (round(src_w * scale), round(src_h * scale))
    resized = img.resize(new_size, Image.LANCZOS)
    left = (new_size[0] - target_w) // 2
    top = (new_size[1] - target_h) // 2
    return resized.crop((left, top, left + target_w, top + target_h))


def ai_outpaint(source: Image.Image, target_w: int, target_h: int, client) -> Image.Image:
    """ČÁST A: rozšíří čtvercový obrázek na cílový poměr stran.

    Postup:
      1) Sestaví plátno cílového poměru se zdrojem uprostřed (_build_outpaint_canvas).
      2) Pošle ho modelu gemini-2.5-flash-image s instrukcí dokreslit okraje.
      3) Výsledek zmenší/ořízne na PŘESNÉ rozměry target_w × target_h.
    Při jakémkoliv problému se použije deterministický Pillow fallback.
    """
    # Bez klienta rovnou fallback.
    if client is None:
        return _fallback_extend(source, target_w, target_h)

    canvas = _build_outpaint_canvas(source, target_w, target_h)

    prompt = (
        "Extend and outpaint this image to fill the entire frame. "
        "Keep the central subject exactly as it is and seamlessly continue "
        "the background, lighting and style into the empty margins. "
        "Do not add any text, logos or watermarks. Photorealistic, clean result."
    )

    try:
        # google-genai umí přijmout PIL.Image přímo v seznamu contents.
        response = client.models.generate_content(
            model=IMAGE_MODEL,
            contents=[prompt, canvas],
        )

        out_img = _extract_image(response)
        if out_img is None:
            print("  [AI] Odpověď neobsahovala obrázek – použiji fallback.")
            return _fallback_extend(source, target_w, target_h)

        # Model nevrací přesné rozměry → srovnáme na cílový formát (cover + crop).
        return _resize_cover(out_img, target_w, target_h)

    except Exception as exc:  # noqa: BLE001
        print(f"  [AI] Volání API selhalo ({exc}) – použiji fallback.")
        return _fallback_extend(source, target_w, target_h)


def _extract_image(response) -> Image.Image | None:
    """Vytáhne z odpovědi GenAI první obrázkovou (inline) část."""
    candidates = getattr(response, "candidates", None) or []
    for candidate in candidates:
        parts = getattr(candidate.content, "parts", None) or []
        for part in parts:
            inline = getattr(part, "inline_data", None)
            if inline and inline.data:
                return Image.open(io.BytesIO(inline.data)).convert("RGB")
    return None


# --------------------------------------------------------------------------- #
#  ČÁST B – KOMPOZIČNÍ MODUL (Layout engine přes Pillow)
# --------------------------------------------------------------------------- #

@dataclass
class Banner:
    """Pomocný kontejner – obrázek banneru + jeho kreslicí kontext."""
    image: Image.Image
    draw: ImageDraw.ImageDraw

    @property
    def width(self) -> int:
        return self.image.width

    @property
    def height(self) -> int:
        return self.image.height


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont,
               max_width: int) -> list[str]:
    """Zalomí text na více řádků tak, aby žádný nepřesáhl max_width (word wrap).

    Pracuje po slovech; pokud je jedno slovo samo o sobě širší než max_width,
    nechá ho na samostatném řádku (raději přetečení než nekonečná smyčka).
    """
    words = text.split()
    lines: list[str] = []
    current = ""

    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=font) <= max_width or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def _fit_font(draw: ImageDraw.ImageDraw, text: str, max_width: int, max_height: int,
              line_spacing: float = 1.15) -> tuple[ImageFont.FreeTypeFont, list[str]]:
    """Najde největší velikost fontu, při které se zalomený text vejde do plochy.

    Začíná u velikosti odvozené z výšky banneru a postupně zmenšuje, dokud se
    všechny řádky nevejdou do max_width × max_height. Vrací font i hotové řádky.
    """
    # Horní odhad velikosti písma podle dostupné výšky.
    size = max(10, max_height)

    while size >= 8:
        try:
            font = ImageFont.truetype(FONT_PATH, size)
        except OSError:
            # Font nelze načíst – spadneme na vestavěný (bez škálování).
            font = ImageFont.load_default()
            return font, _wrap_text(draw, text, font, max_width)

        lines = _wrap_text(draw, text, font, max_width)
        line_h = (font.getbbox("Ag")[3] - font.getbbox("Ag")[1]) * line_spacing
        total_h = line_h * len(lines)
        widest = max((draw.textlength(ln, font=font) for ln in lines), default=0)

        if total_h <= max_height and widest <= max_width:
            return font, lines
        size -= 2

    # Pojistka – nejmenší rozumná velikost.
    font = ImageFont.truetype(FONT_PATH, 8)
    return font, _wrap_text(draw, text, font, max_width)


def draw_headline(banner: Banner, text: str) -> None:
    """Vykreslí nadpis do horní poloviny banneru, vycentrovaný, se zalomením."""
    max_width = banner.width - 2 * SAFE_MARGIN
    # Text patří do horní poloviny → výškový rozpočet je cca polovina banneru.
    max_height = banner.height // 2 - SAFE_MARGIN

    font, lines = _fit_font(banner.draw, text, max_width, max_height)

    # Výška řádku podle aktuálního fontu.
    ascent_descent = font.getbbox("Ag")
    line_h = (ascent_descent[3] - ascent_descent[1]) * 1.15
    block_h = line_h * len(lines)

    # Vertikálně vycentrujeme blok v horní polovině banneru.
    y = max(SAFE_MARGIN, (banner.height // 2 - block_h) // 2)

    for line in lines:
        line_w = banner.draw.textlength(line, font=font)
        x = (banner.width - line_w) // 2  # horizontální vycentrování
        # Lehký světlý "stín" pro čitelnost přes různá pozadí.
        banner.draw.text((x + 1, y + 1), line, font=font, fill=(255, 255, 255))
        banner.draw.text((x, y), line, font=font, fill=TEXT_COLOR)
        y += line_h


def paste_logo(banner: Banner, logo: Image.Image) -> None:
    """Vloží logo na střed spodní hrany s odsazením SAFE_MARGIN odspodu.

    Logo proporcionálně zmenší, aby nezabralo víc než ~45 % šířky a ~30 %
    výšky banneru (u úzkých/nízkých formátů jinak nevypadá dobře).
    """
    max_logo_w = int(banner.width * 0.45)
    max_logo_h = int(banner.height * 0.30)

    logo = logo.copy()
    logo.thumbnail((max_logo_w, max_logo_h), Image.LANCZOS)  # zachová poměr stran

    x = (banner.width - logo.width) // 2
    y = banner.height - logo.height - SAFE_MARGIN

    # Použijeme alfa kanál jako masku, ať je průhlednost loga zachovaná.
    mask = logo if logo.mode == "RGBA" else None
    banner.image.paste(logo, (x, y), mask)


def compose_banner(base: Image.Image, headline: str, logo: Image.Image | None) -> Image.Image:
    """ČÁST B: do AI-rozšířeného pozadí složí nadpis a logo."""
    image = base.convert("RGB")
    banner = Banner(image=image, draw=ImageDraw.Draw(image))

    draw_headline(banner, headline)
    if logo is not None:
        paste_logo(banner, logo)
    return banner.image


# --------------------------------------------------------------------------- #
#  SPOJENÍ DO PIPELINE
# --------------------------------------------------------------------------- #

def _load_inputs() -> tuple[Image.Image, Image.Image | None]:
    """Načte vstupní soubory a srozumitelně nahlásí chybějící povinné vstupy."""
    if not os.path.exists(BACKGROUND_PATH):
        sys.exit(
            f"CHYBA: chybí povinný soubor {BACKGROUND_PATH}\n"
            "Připrav prosím čtvercový obrázek pozadí (viz README.md)."
        )
    background = Image.open(BACKGROUND_PATH).convert("RGB")

    logo = None
    if os.path.exists(LOGO_PATH):
        logo = Image.open(LOGO_PATH).convert("RGBA")
    else:
        print(f"  [POZOR] Logo {LOGO_PATH} nenalezeno – bannery budou bez loga.")

    if not os.path.exists(FONT_PATH):
        print(f"  [POZOR] Font {FONT_PATH} nenalezen – použije se vestavěný font Pillow.")

    return background, logo


def main() -> None:
    """Hlavní spouštěcí smyčka: pro každý formát ČÁST A → ČÁST B → uložení."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    background, logo = _load_inputs()
    client = _get_genai_client()

    print(f"Generuji {len(FORMATS)} formátů bannerů...\n")

    for fmt in FORMATS:
        w, h = fmt["w"], fmt["h"]
        print(f"-> Formát {w}x{h}:")

        # ČÁST A – rozšíření pozadí.
        print("   ČÁST A: outpainting pozadí...")
        expanded = ai_outpaint(background, w, h, client)

        # ČÁST B – kompozice loga a textu.
        print("   ČÁST B: skládání loga a textu...")
        final = compose_banner(expanded, HEADLINE, logo)

        out_path = os.path.join(OUTPUT_DIR, f"banner_{w}x{h}.jpg")
        final.save(out_path, "JPEG", quality=90)
        print(f"   Uloženo: {out_path}\n")

    print("Hotovo! Vygenerované bannery najdeš ve složce 'outputs'.")


if __name__ == "__main__":
    main()
