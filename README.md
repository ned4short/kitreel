# KitReel (GitHub version)

Free soccer highlight reels: upload a game video, pick the team, tag your player, and download their reel. Everything runs in the visitor's browser (TensorFlow.js + COCO-SSD for players and the ball, ffmpeg.wasm to cut the reel); the video never leaves their device.

Live: https://kitreel.nedwebservices.com/ · Original Replit version: https://kitreel.replit.app/

Differences from the Replit version:
- No server: video limits are fixed in `app.js`, there are no upload share links (the Share button hands the file to the device's share sheet where supported), and the footer visit counter is replaced by Ned Traffic.
- "Only keep my player in action" (on by default): while following a tagged player, KitReel also looks for the ball near them every half second and keeps only the moments they're on or near the ball, or in a challenge, instead of the whole follow. "How close to the ball" sets the distance: Tight 1.0, Normal 1.5, Loose 2.5 player-heights. If the ball is rarely visible, it falls back to challenges and moments where players bunch up. Logic: `actionSegments()` in `auto-pick.js`; ball data is collected in `tracker.js`.

Vendor files (`vendor/`, `models/`) are TensorFlow.js, the COCO-SSD model and ffmpeg.wasm, copied as-is from the Replit project.

Reel extras (GitHub version):
- The crop pans with the tracked player (smoothed, `cameraFor()` in `reel-fx.js`), so vertical reels keep the player in frame.
- Spotlight: a yellow ring at the player's feet for the first 2 s of each clip (`spotlightFor()`).
- Title card (player number, name, team, game date) and a "Made with KitReel" end card, 2.5 s each.
- "Your clips" panel: preview, trim (±1 s) or remove each clip before making the reel; after the reel, each clip can be downloaded on its own.
- Tip prompt after the reel is made.
