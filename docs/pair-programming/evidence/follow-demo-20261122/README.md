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

The recorded run used temporary workspace-only `workbench.reduceMotion: off` and `editor.smoothScrolling: true`, removed after capture. Public media is a normal-speed 33-second continuous excerpt, cropped from an 80-second desktop recording. MP4 and GIF share this filter before frame-rate conversion:

```text
crop=1530:780:340:80,
drawbox=x=1294:y=0:w=236:h=470:color=0x1e1e1e:t=fill,
drawbox=x=1302:y=485:w=228:h=70:color=0x1e1e1e:t=fill
```

The masks cover agent details and local identity/root fields; synthetic relative paths remain visible. Source capture was approximately 28.08 fps variable-rate; published MP4 and GIF are resampled to 30 and 20 fps without speeding playback. Visual checks used sampled frames and a consecutive-frame strip; they are not a latency benchmark.

Run the final fixture tests independently:

```sh
node --test --test-concurrency=1 docs/pair-programming/evidence/follow-demo-20261122/shipping-total.test.mjs
```
