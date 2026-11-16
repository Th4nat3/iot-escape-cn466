# IoT ESCAPE — CN466 AIoT Learning Game

โครงงานเว็บไซต์เกมการเรียนรู้ AIoT วิชา CN466 รองรับ 6 Missions และการสาธิต ESP32-S2 (Cucumber R) ผ่าน USB Serial PING/ACK รวมถึงการตรวจสถานะ Wi-Fi/HTTP

## Current deployment status

> Repository created. **Source files and GitHub Pages deployment have not yet been uploaded or verified.** This README is a staging document.

## Project features

- Six learning missions (M01–M06), local progress and score display.
- ESP32-S2 USB Serial gateway with request-id-based PING/ACK.
- Optional phone hotspot firmware with `/status` endpoint.
- Optional RGB LED firmware and browser-based local AI demo. These optional features require separate real-device verification.

## Run locally (after uploading the project files)

1. Install Node.js as specified by the project and run `npm ci`.
2. Run `npm test`, `npm run lint`, and `npm run build`.
3. Start the site with `npm run dev` and open the displayed localhost URL.
4. For serial hardware tests, use Chrome/Edge on `localhost`, open the hardware monitor and select the ESP32-S2 serial port. Do not leave Arduino Serial Monitor or other serial tabs connected.
5. Never add real hotspot passwords, API keys, or private configuration files to this public repository.

## Submission evidence

Distinguish unit test results, local browser demonstrations and hardware tests. Past testing confirmed browser missions, Serial PING/ACK and an iPhone Safari response from the board's `/status` endpoint; GPIO/RGB and MQTT must not be labelled verified without separate physical tests.

## GitHub Pages

The project's `.github/workflows/deploy-pages.yml` is designed to deploy a Vite build after all source files are uploaded. Open **Settings → Pages → Build and deployment → Source: GitHub Actions**, then check the deployment in **Actions**. Project site URL is expected to be `https://th4nat3.github.io/iot-escape-cn466/` **only after deployment succeeds**.

## Credits

CN466 student learning project, developed with AI assistance. Keep screenshots and prompts of the development/review flow for the submission video.
