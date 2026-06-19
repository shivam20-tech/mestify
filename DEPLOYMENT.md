# Mestify Deployment

## Render

1. Push this project to GitHub.
2. In Render, create a new Web Service from the repo.
3. Use:
   - Build command: `npm ci`
   - Start command: `npm start`
   - Health check path: `/health`
4. Keep the app on HTTPS. Safari/iPhone background audio is much more reliable from HTTPS, especially when installed to the Home Screen.

## Safari Background Playback

Mestify uses a normal HTML `<audio>` element with streamed audio from `/api/stream/:id`. For iPhone Safari and lock-screen playback:

- Start music from a real tap on a song or play button.
- Keep the app served over HTTPS.
- Install it to the Home Screen for the best iOS behavior.
- Do not cache `/api/*` or `/api/stream/*`; the service worker intentionally skips those routes.

If iOS pauses because of a network interruption, return to the app and tap play once to resume.
