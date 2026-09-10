# 速览 Fast PDF Viewer

A dark, reading-first PDF viewer for Windows. Built for people who find Edge's PDF preview slow, hard to jump back from, and weak at search.

- Fast open and continuous scrolling, default zoom 150%
- Browser-style back/forward after TOC, links, or search jumps (mouse side buttons, Alt+←, Backspace)
- Search with a result list and a **3 / 47** counter
- Select text and translate it with your own [OpenRouter](https://openrouter.ai/) API key

The first version is **Python + WebView2 + pdf.js**. No Node or Rust required.

## Run

Python 3.10+ on Windows.

```powershell
git clone https://github.com/Stewart222b/fast-pdf-viewer.git
cd fast-pdf-viewer
python -m pip install -r requirements.txt
python desktop\app.py
```

Open a file directly:

```powershell
python desktop\app.py D:\docs\manual.pdf
```

If `pywebview` is not installed, it falls back to the system browser:

```powershell
python desktop\app.py --browser
```

The first launch downloads pdf.js assets into `web/vendor/pdfjs`.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Open | Ctrl+O, or drop a PDF onto the window |
| Back | Mouse back button, Alt+←, Backspace |
| Forward | Mouse forward button, Alt+→ |
| Search | Ctrl+F, results listed in the sidebar |
| Zoom | Ctrl + wheel, default 150% |
| Translate | Select text → 翻译 |

## Translation

Open Settings and fill in:

- OpenRouter API key (`sk-or-v1-...`)
- Model id, default `openai/gpt-4o-mini` (any OpenRouter model works)
- Target language, default Simplified Chinese

The key stays in local `localStorage` and is only sent to OpenRouter.

## License

MIT
