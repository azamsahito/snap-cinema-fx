# Snap & Cinema FX

A Chrome extension that adds gesture-triggered effects to your live camera in Google Meet and any other web video call. Everyone on the call sees them.

- **Snap** your fingers: you turn to dust while your room stays visible. Snap again to come back.
- **Double snap**: cash rain falls over the frame.
- **Both hands up**: Absolute Cinema, with your live face placed into the meme.
- **Hand over your eyes**: a facepalm meme fades in over you.
- **Background blur** that keeps the effects sharp (use it instead of Meet's blur).

Everything runs locally in your browser with Google MediaPipe. No video or audio is sent anywhere.

## Install

1. Click the green **Code** button above, then **Download ZIP**, and unzip it somewhere permanent.
2. Add your meme pictures to the `memes` folder (see [memes/README.md](memes/README.md)), or choose them later from the popup.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Pin the extension, then reload any open Meet tab.

## Use it

Open Google Meet. The pre-join screen with your self-view is the best place to test.

| Gesture | Effect | Keyboard backup |
|---|---|---|
| Snap | Vanish / come back | `Alt+Shift+S` |
| Double snap | Cash rain | `Alt+Shift+M` |
| Both hands up | Absolute Cinema | `Alt+Shift+C` |
| Hand over eyes | Facepalm | `Alt+Shift+F` |

Tips: use good lighting and keep your hand clearly in view. Lean out of frame for a second after your camera starts so the extension can learn your background. If snaps are missed, set sensitivity to **High** in the popup.

## How it works

- `inject.js` wraps `getUserMedia` so the call site receives a processed camera track.
- `engine.html` / `engine.js` run MediaPipe hand, face and pose tracking, the dust particles and the cinema grade in a hidden extension frame.
- `bridge.js` connects the two, and `popup.html` holds the settings.

## Credits

- Tracking: [Google MediaPipe](https://github.com/google-ai-edge/mediapipe) (Apache 2.0)

## License

MIT. See [LICENSE](LICENSE).
