# Accessibility and device acceptance matrix

Automated CI covers Chromium desktop, Pixel 7 Chrome emulation, iPhone 15 WebKit
emulation, keyboard tab navigation, serious/critical axe findings, responsive overflow,
manifest registration and offline-shell reloads.

Before a release, complete these manual checks because emulation cannot reproduce assistive
technology or physical-device behavior:

- macOS Safari with VoiceOver: sign in, navigate every tab, operate dialogs and cooking mode.
- iPhone Safari with VoiceOver: complete the same flow and install/open the home-screen PWA.
- Android Chrome with TalkBack: scan a barcode/photo, navigate tabs, and install/open the PWA.
- Keyboard only: complete recipe, pantry, shopping and meal-plan workflows; verify focus return.
- Offline: launch the installed PWA without connectivity and confirm no private API data is cached.

Record device/OS/browser versions, result, tester and date in the release notes.
