# thompsonswe.com

The website for Thompson SWE LLC. Plain HTML, CSS, and one small script. No build step.

## Deploying

GitHub Pages serves the `main` branch at https://thompsonswe.com (see `CNAME`).
Push to `main` and the site updates in about a minute.

DNS for the domain is managed at Squarespace Domains. Nothing here depends on AWS Amplify.

## Files

| Path | What it is |
|---|---|
| `index.html` | The home page |
| `capabilities/index.html` | One-page capability statement; prints on a single Letter page |
| `404.html` | Not-found page |
| `style.css` | All styles, including dark mode and print |
| `site.js` | The reorder-point demo in the page header |
| `fonts/` | Barlow and Barlow Condensed, self-hosted (SIL Open Font License, see `fonts/OFL.txt`) |
| `img/og.png` | Social sharing card |
| `sitemap.xml`, `robots.txt` | For search engines |

## Previewing locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Paths are absolute, so open it through a server, not as a file.
