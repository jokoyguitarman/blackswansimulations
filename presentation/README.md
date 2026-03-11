# Black Swan Simulations – Client Pitch Deck

Client-facing pitch deck for organisations (companies, agencies, special forces) who want to run crisis simulation exercises with Black Swan Simulations. Emphasises AI-driven scoring, branching outcomes, timeliness of decisions, and efficiency over tabletop exercises.

## How to Run

1. **Deployed (recommended):** Open **https://blackswansimulations.vercel.app/presentation/** — the live demo panel will load the session in the right half.
2. **Local:** Open `index.html` in a browser — the demo panel shows a fallback link (embedding requires same-origin).

## Navigation

- **Keyboard**: Left/Right arrows, Space (next), Home (first slide), End (last slide)
- **Mouse**: Click "Prev" / "Next" buttons at the bottom
- **URL**: Use `#slide-n` to open a specific slide (e.g. `index.html#slide-5`)

## Slide Structure

1. Title — Black Swan Simulations + tagline
2. Problem — Crisis coordination gaps, tabletop limitations
3. Why Us — Secure, AI-assisted platform
4. AI & Scoring — Decision latency, coordination, robustness, impact matrix
5. Branching Outcomes — Escalation/de-escalation pathways
6. How It Works — Exercise lifecycle
7. Tabletop vs Digital — Comparison
8. Scenarios — Example exercises
9. What You Get — Demo, pilot, custom scenarios, deployment
10. Next Steps — Call to action

## Customization

- **Content**: Edit slide `<section>` elements in `index.html`.
- **Colors**: Adjust CSS variables in `:root` (e.g. `--robotic-yellow`, `--robotic-orange`).
- **Scanline**: Remove the `scanline` class from `<body>` to disable the overlay.

## Export to PDF

Use the browser's Print dialog (Ctrl/Cmd + P) and choose "Save as PDF". Print one slide per page for best results.
