# WikiLLM

**An encyclopedia with no facts in it, only whatever your local model believes.**

WikiLLM is an epistemic inspector for local language models, dressed up as an
encyclopedia. Type a topic, and the model running on your own machine writes
the article while you watch: introduction, infobox, sections, categories, even
a hand-drawn SVG illustration. Every link in the article leads to a page that
does not exist yet. Click it, and the model writes that one too.

Nothing is looked up. There is no retrieval, no search, no ground truth. What
you are reading is a straight printout of the weights, which makes it a very
playable way to find out what is actually in there, and what your model will
confidently invent to fill the gaps.

> WikiLLM is an independent project. It is not affiliated with, endorsed by or
> connected to Wikipedia or the Wikimedia Foundation.

## Exhibits

![A generated article about the coffee plant, with the model's own SVG drawing of one in the infobox](assets/coffee-plant.jpg)

*Asked to draw a coffee plant in raw SVG, a local model draws an actual coffee
plant. Leaves, cherries, the lot. Nobody is more surprised than we are.*

![A generated article describing the War of the Bucket as a satirical dispute](assets/war-of-the-bucket.jpg)

*The War of the Bucket was a real war: Bologna against Modena, 1325, thousands
of soldiers. The model heard the name, decided nobody could be serious, and
filed it as a "satirical dispute".*

![A generated article describing Tarrare as a bird native to Ethiopia](assets/tarrare.jpg)

*Tarrare was an 18th-century French showman famous for eating anything put in
front of him. According to this model he is an undocumented Ethiopian songbird.
The article has categories and everything.*

## Quick start

You need Python 3.9 or newer and a local model server that speaks the
OpenAI-compatible API. There is nothing to install: WikiLLM uses only the
Python standard library.

```bash
git clone https://github.com/EagleClaw0075/wikillm.git
cd wikillm
python3 server.py
```

Your browser opens at http://localhost:8917/. The first time:

1. Go to **Model settings**.
2. Press the button for your server (or **Find running servers**).
3. Pick a model and press **Save settings**.
4. Look something up.

On Windows, use `py server.py`. On a Mac you can also double-click
`start.command`.

### Pointing it at your model server

Any OpenAI-compatible endpoint works. These are the usual addresses, and the
settings page has a one-click button for the first five:

| Server | Address |
|---|---|
| LM Studio (start the local server in the Developer tab) | `http://localhost:1234/v1` |
| Ollama (`ollama serve`) | `http://localhost:11434/v1` |
| llama.cpp (`llama-server -m your-model.gguf`) | `http://localhost:8080/v1` |
| vLLM (`vllm serve your-model`) | `http://localhost:8000/v1` |
| Jan | `http://localhost:1337/v1` |
| KoboldCpp | `http://localhost:5001/v1` |
| text-generation-webui | `http://localhost:5000/v1` |

Prefer a file to a settings page? Copy `.env.example` to `.env` and fill it in:

```bash
cp .env.example .env
```

```ini
WIKILLM_BASE_URL=http://localhost:11434/v1
WIKILLM_API_KEY=
WIKILLM_MODEL=your-model-name
WIKILLM_PORT=8917
```

`.env` gives the starting values; anything you save in **Model settings** wins.
Command-line options: `--port 8700` for another port, `--no-browser` to not
open a tab.

## Things to poke at

- **Rabbit holes.** Every link is a page waiting to be written. Follow one fact
  six clicks deep and watch how long the model's world stays consistent.
- **View thinking trace.** At the foot of each article, a collapsed box holds
  the model's reasoning for every part of the page. This is where you find out
  *how* it talked itself into the songbird.
- **View source.** The exact prompts sent and the raw replies received, one
  request at a time.
- **Regenerate.** Ask again and compare. Hallucinations that survive a re-roll
  are the interesting ones.
- **Illustrations.** Tick "Ask the model to draw an illustration" in settings
  and every article gets an SVG drawn by the model, live. Small models lean
  towards abstract art.
- **Categories.** Category pages are generated too, and they list articles the
  model thinks should exist.
- **Swap models.** Same topic, different weights, different reality.

## How a page is built

Each article is several small requests, which is what the progress bar counts:

1. section outline
2. introduction
3. infobox facts
4. one request per section
5. "See also" links
6. categories
7. (optional) an SVG illustration

The outline comes first and the introduction second. After that the infobox
and every section need only those two, and "See also", categories and the
illustration need only the title, so they are all sent together, up to
**Requests at once** in settings (1 to 6). That only saves time if your server
runs requests in parallel; a server that takes one at a time just queues them.

Reasoning models sometimes get stuck, repeating the same few sentences until
the token budget is gone. WikiLLM watches the reasoning as it streams, stops a
request once a sentence has come round eight times, and asks again with less
reasoning effort (`medium`, then `low`). **Reasoning effort** in settings sets
the level every request starts at; servers that do not understand
`reasoning_effort` ignore it.

## Privacy

- The server listens on `127.0.0.1` only and refuses requests that do not come
  from its own page.
- It contacts one thing: the API address you give it. The only exception is
  **Find running servers** (also tried once on a first visit), which checks the
  usual model-server ports on `localhost`. No analytics, no fonts or scripts
  from a CDN, no update checks.
- Your settings live in `config.json` and generated pages in `cache/`, both
  next to `server.py` and both ignored by git. An API key, if you enter one, is
  stored in `config.json` as plain text.

## Files

- `server.py` - local web server, model proxy and page store
- `static/` - the web page (`index.html`, `style.css`, `app.js`)
- `.env.example` - optional starting values for the connection
- `config.json` - your settings (created when you save them)
- `cache/` - generated pages, one JSON file each; delete freely

## Disclaimer

Everything WikiLLM shows is generated by a language model and can be wrong,
including when it sounds certain. That is the point of the exercise; please do
not cite it.

WikiLLM is not affiliated with, endorsed by or connected to Wikipedia or the
Wikimedia Foundation. "Wikipedia" is a trademark of the Wikimedia Foundation.

## License

[MIT](LICENSE) © 2026 EagleClaw0075
