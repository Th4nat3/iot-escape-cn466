# IoT ESCAPE — CN466 AIoT Learning Game

Educational six-mission AIoT escape room built with React, TypeScript and Vite, developed with AI assistance and verified with automated tests. This repository contains the application, tests, and optional Cucumber R (ESP32-S2) firmware.

## Project content
- **M01–M06**: interactive learning missions about data, HTTP/JSON, AI instructions and RGB, with local progress and a score out of 100.
- **Local AI demo**: small Multinomial Naive Bayes classifier running in the browser in M04; it is not a cloud LLM or automatic hardware controller. Scoring logic remains rule-based.
- **ESP32-S2 gateway**: Web Serial USB link with request ID matching and PING/ACK; optional Wi-Fi hotspot firmware exposing HTTP `/status`.
- **Optional RGB experiment**: separate firmware sketch and browser controls; must be flashed and physically tested before describing GPIO/RGB as working.
- **MQTT** is not implemented. Sensor measurements remain `null` when hardware sensors are absent.

## Run locally
Requires Node.js compatible with Vite 8 (Node.js 22 recommended).
```sh
npm install
npm test
npm run lint
npm run build
npm run dev
```
Open the local address printed by Vite (normally http://localhost:5173/). For USB Serial, use Chrome/Edge on a compatible computer and allow the ESP32-S2 port. Keep Arduino Serial Monitor and other serial test tabs disconnected.

## GitHub Pages deployment
The workflow `.github/workflows/deploy-pages.yml` runs installation, 35 automated tests, ESLint, Vite build, and GitHub Pages deployment. To activate it **once**, go to **Settings → Pages → Build and deployment → Source: GitHub Actions** and rerun the latest workflow in **Actions**.

After a **successful deployment** the expected site URL is https://th4nat3.github.io/iot-escape-cn466/ . Do not treat this URL as live until GitHub shows the deployment passed and the page opens.

## Verification status (November 16, 2026)
- 35/35 automated tests, ESLint and Vite build passed in GitHub Actions run [#3](https://github.com/Th4nat3/iot-escape-cn466/actions/runs/43886586356).
- GitHub Pages deployment was blocked at `configure-pages` because Pages had not yet been enabled in repository settings.
- Prior real-board evidence supplied by the student shows USB Serial PING/ACK, hotspot connection and iPhone Safari HTTP `/status`.
- Physical RGB/GPIO, MQTT, and a deployed site's end-to-end browser flow are **not verified**.

See [submission and demo checklist](docs/CN466_SUBMISSION_TH.md).

**Security:** Do not commit hotspot passwords, access tokens, .env credentials, or files from node_modules.
