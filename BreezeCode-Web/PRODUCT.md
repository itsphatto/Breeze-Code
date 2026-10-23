# Product

<!-- impeccable:product-schema 1 -->

Scope: the Breeze Code marketing site (`BreezeCode-Web/`), meaning the landing page, FAQ, privacy and terms. The desktop app's product record is `../PRODUCT.md`, and its users, positioning and principles apply here too.

## Platform

web

## Users

- **Primary:** new and hobby coders who are deciding whether to download Breeze Code. They may not know the terms "agent", "LLM" or "Ollama" yet.
- **Also:** working developers comparing Breeze with heavier AI editors, who look for bring-your-own-agent support, local models and a small footprint.

## Product Purpose

The site explains what Breeze Code is, shows the plan → approve → build flow, answers trust questions (cost, safety, privacy, platform), and sends people to download the Windows installer. Success means a visitor understands the product and downloads it from the official GitHub release.

## Positioning

The same four pillars as the app: plan → approve → build, bring your own agent, light and local, and fun while you wait. The site's job is to make all four believable to a beginner.

## Operating Context

- Static HTML/CSS/JS (`index.html`, `FAQ.html`, `privacy.html`, `terms.html`, `styles.css`, `site.js`, `ide-demo.js`/`.css`, `sfx.js`), deployed on Vercel from this folder with no build step.
- An interactive IDE demo (`ide-demo.*`) and sound effects with adjustable volume (`sfx.js`) are part of the page.
- Downloads point to `https://github.com/itsphatto/BreezeCode/releases/latest`. The source is linked at `https://github.com/itsphatto/BreezeCode`.
- Local preview runs on `python -m http.server 5181` from `.claude/launch.json` (`breeze-web`).

## Capabilities and Constraints

- Facts the site may state: free and open source (MIT); Windows 10/11 64-bit only, with no Mac or Linux version yet; installer of about 110 MB; unsigned, so SmartScreen warns ("More info → Run anyway"); detects Codex and Antigravity; runs local models via Ollama, LM Studio or any OpenAI-compatible server; F5 runs Python, C, C++ and C#; JS runs via Node; HTML/CSS live preview; Java and Rust are "on the way"; updates ask before downloading.
- Privacy: files stay on the machine. Cloud agents send task data to their provider under that provider's terms. Keys are encrypted with the Windows keychain.

## Brand Commitments

- Name: **Breeze Code**. Brand assets: `assets/brand/` (Icon, BreezeCode wordmark, Agent), plus favicons in the site root.
- Thai place imagery is already in use as backgrounds (`assets/screens/Bangkokaerialview.jpg`, `chaphrayaView.jpg`, `pattayacityview.png`).
- Voice: plain, short, and direct, with questions answered the way the FAQ answers them.

## Evidence on Hand

- Real product screenshots in `assets/screens/` (IDE, plan, Git, setup agents, Box, Vibe).
- Agent logos (`assets/agents/`) and language logos (`assets/langs/`).
- **The "Up to 12× less memory" line is a rough estimate.** Keep it hedged ("up to"), don't make it more specific, and don't present it as a benchmark.
- There are no testimonials, user counts, download stats, press or company logos. Don't make any up.

## Product Principles

1. **Show the real product.** Use real screenshots and the working demo rather than abstract illustrations of AI.
2. **Earn trust upfront.** Free, open source, local and the SmartScreen warning are explained plainly and early, not buried.
3. **Beginner-first language.** Explain every term or avoid it. Experts will skim past it, but beginners would bounce off it.
4. **One clear action.** Everything leads to downloading from the official GitHub release.
