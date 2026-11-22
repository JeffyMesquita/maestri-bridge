# Synthetic Follow recording fixture

This fixture drives the real editor through the cooperative activity helper. It does not intercept arbitrary tools or authenticate which process wrote a file.

Start Follow in a trusted local Development Host and choose a demonstration agent. Keep that window visible. Copy only the activity context delivered to that agent into a temporary JSON file outside the repository:

```json
{
  "sessionId": "<current Follow session>",
  "agentId": "<selected agent>",
  "root": "<absolute repository root>",
  "editorPath": "<absolute editor executable>",
  "uriBase": "<activity URI base delivered by the editor>",
  "firstSequence": 1
}
```

Do not copy pairing credentials, TLS pins or access tokens. Use an unused sequence number if this session already published activity. Keep the local context out of commits.

Run from the repository root:

```sh
node docs/pair-programming/evidence/follow-demo-20261122/run-demo.mjs path/to/local-context.json
```

The script writes only its own two synthetic fixture files, creates three `focus` updates and one `decision`, then publishes the fifth event returning to the source. It runs the fixture's three tests and saves relative paths, revisions and event timings in `events.json`. Explanations are delivered to the Chat card; the document is never rewritten to simulate animation. Follow remains active at the end so Pause/Resume/Stop can be checked separately.

The recorded run used temporary workspace-only `workbench.reduceMotion: off` and `editor.smoothScrolling: true`, removed after capture. Public media is a normal-speed 33-second continuous excerpt from an 80-second desktop recording. Both formats preserve the complete 1920 × 1032 window, including title, tabs, Agents panel, code, Follow card, terminal and status bar. No spatial crop, resizing or panel masks are applied. Only frame-rate/palette conversion is used:

```text
MP4: fps=30
GIF: fps=20, palettegen/paletteuse (128 colors)
```

The complete window preserves the navigation context. Source capture was approximately 28.08 fps variable-rate; published MP4 and GIF are resampled to 30 and 20 fps without speeding playback. Visual checks used sampled frames and a consecutive-frame strip; they are not a latency benchmark.

Run the final fixture tests independently:

```sh
node --test --test-concurrency=1 docs/pair-programming/evidence/follow-demo-20261122/shipping-total.test.mjs
```
