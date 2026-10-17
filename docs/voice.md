# Voice

Talk to Genio's chat and hear its replies, all on this PC: nothing is sent anywhere and nothing costs money. The only
settings are **Read replies aloud** and, once the natural voice is downloaded, the **Voice** under it.

## Voice input (push to talk)

- **The mic button** sits in every chat box (the main chat, a project chat, the floating panel, the chat pop-out and
  design chats), before Steer and Send. It is the only control and the only indicator:
  - pressed, with a ring that follows your voice, while it listens;
  - a spinner while the words are worked out (about 2 s; up to about 6 s while Unity compiles);
  - a progress ring during the one-time download.
- **Click** to start, click again to stop. **Hold F8** anywhere in Genio to talk until you release it, except while
  the game view on the Play screen has the keys (they go to the game). With several chat boxes on screen, F8 talks
  into the one that has focus, else the one you used last. **Enter** while listening stops too.
- **The words wait in the box.** They are inserted at the caret like typed text; nothing is sent until you press Enter
  (send, or queue while Genio works) or Ctrl+Enter / Steer (steer). Slash commands and `!` shell mode keep their meaning.
- **Starting to talk stops Genio speaking** (push-to-talk barge-in).
- **Up to 60 s** per recording; it stops by itself at the limit and types what it heard.
- **Errors** show as one line under the chat box: Windows blocking the microphone (Windows' privacy settings for the
  microphone: "Let desktop apps access your microphone"), no microphone, or no speech heard.

### The speech model

- **whisper.cpp v1.8.2** (MIT) with OpenBLAS (BSD-3) and the English **small.en** model, quantized
  (`ggml-small.en-q5_1.bin`, MIT weights). English only.
- **Download on consent only.** The first press opens a small panel that names the size (about 206 MB to download,
  about 240 MB on disk) with Download and Not now. Nothing downloads before Download.
  - Pinned URLs (the GitHub release zip and a fixed Hugging Face revision) with pinned SHA-256 hashes.
  - Resumable: an interrupted download continues where it stopped the next time.
  - Verified before use; a file whose hash does not match is deleted.
  - Stored in Genio's own data folder (`<Genio home>/data/voice/`), never in a project. Only the server and its
    DLLs are kept from the release zip. Remove the folder to remove the model; the next press asks again.
- **Runs lazily.** The first recording starts `whisper-server` on `127.0.0.1` at a random port, on the CPU only (`-ng`:
  Unity and Play keep the GPU), 4 threads, greedy decoding, `-ac 768`, at above-normal priority so a busy CPU slows it
  less. It holds about 0.3–0.5 GB of RAM and exits after 10 idle minutes and when Genio quits.
- **Accuracy.** Each request carries a short vocabulary prompt: Genio's terms (Genio, Unity, Modeller, FAL, Uthana,
  Codex, Gauntlet, Art Bible, recon, merge, rebase, Steer) plus the current project names and live unit titles.
  - Silence is never sent to the model.
  - Whisper's silence hallucinations ("Thank you.", "you", `[BLANK_AUDIO]`) are dropped when the clip held no speech.
  - `-ac 768` covers about 15 s per window, so a longer recording is split at its quietest point near 14 s, sent in
    parts and joined.

### Privacy

- The microphone is open only while you record; its tracks stop as soon as you stop, so Windows' mic icon goes away.
- Audio is recorded with echo cancellation, noise suppression and automatic gain at 16 kHz, kept in memory, sent only to
  Genio's main process and the local server, and never written to disk.
- **Permissions.** Genio answers every browser permission itself: only its own windows (a project or Hub window and
  its chat pop-out) may use the microphone, for audio only and never from an embedded frame; besides that they keep
  only what the UI uses (clipboard, pointer lock, full screen). Everything else is denied.

## Read replies aloud

- **Settings → General → Read replies aloud** (off by default). Genio speaks the last text of each successful chat
  turn, in the windows that show that chat (never twice, never in the Hub). Speech starts at the end of the turn. An
  event turn with nothing to report ends silent and is never spoken.
- **Settings → General → Voice**, directly under the toggle, picks who speaks. It is shown only while Read replies
  aloud is on and the natural voice is downloaded, with nothing else around it. It lists the 11 Kokoro voices under
  plain names (Default for `af`, then Bella, Nicole, Sarah, Sky, Adam, Michael, Emma (British), Isabella (British),
  George (British), Lewis (British)) and last **Windows voice**, which always speaks with the Windows voice. The default
  is Default (voice 0), so nothing changes for anyone who never touches it. The choice is saved in the settings
  (`replyVoice`) and applies from the next spoken sentence; Genio's chat can change it too (`settings_update`).
- What is spoken: code blocks become "code block omitted", tables are skipped, URLs become "link", file paths become
  "path", and a long reply is cut at a sentence end near 600 characters.
- **Pressing the mic, or Esc in the chat box, stops it at once.** A newer reply replaces an older one.
- Tool calls, permission asks and system lines are never spoken. **The Bot never speaks**, and sending any message
  still ends AFK as typed text does.

### The natural voice (Kokoro)

- **Offered once, opt-in.** The first time a reply is read aloud while the natural voice is missing, a small panel at
  the mic button of the chat box in use offers it: a one-time download of about 329 MB (about 392 MB on disk), with
  Download and Not now. That reply, and every reply until the voice is ready, uses the Windows voice.
  - **Not now** is remembered: replies keep the Windows voice and the panel stays away. Turning Read replies aloud off
    and on again brings the offer back on the next reply.
  - The download is separate from the speech model's, with its own consent. The mic button shows its progress ring
    and stays usable; a failure shows one line under that chat box.
- **What is downloaded** (pinned URLs with pinned SHA-256; resumable; verified before use; a bad hash deletes the file):
  - the sherpa-onnx 1.13.8 Node addon for Windows x64 (`sherpa-onnx-win-x64` from the npm registry, 8.9 MB: the addon,
    its C API and onnxruntime; Apache-2.0 and MIT, with espeak-ng built in, GPL-3.0-or-later);
  - Kokoro en v0.19 from the sherpa-onnx `tts-models` release (320 MB: the 82M-parameter model, 11 voices, the token
    list and espeak-ng's phoneme data; weights Apache-2.0). The voices, by speaker id: 0 `af`, 1 `af_bella`,
    2 `af_nicole`, 3 `af_sarah`, 4 `af_sky`, 5 `am_adam`, 6 `am_michael`, 7 `bf_emma`, 8 `bf_isabella`, 9 `bm_george`,
    10 `bm_lewis` (`src/shared/reply-voice.ts`). Genio speaks with voice 0 unless another is chosen.
  - Stored in `<Genio home>/data/voice/kokoro/`; only the addon's binaries and the model folder are kept.
- **Removing it:** quit Genio (or leave the voice idle for 10 minutes) and delete `<Genio home>/data/voice/kokoro/`;
  the next spoken reply offers it again.
- **How it speaks.** The cleaned reply is split into sentences. Genio's helper (below) makes one sentence at a time and
  the chat window plays each through its own audio (an `AudioContext` queue) as soon as it arrives, while the next one
  is made. Because the audio now plays through Chromium, the microphone's echo canceller can hear it.
- **The helper** is `resources/kokoro-helper.cjs`, run as its own process (Genio's Electron run as Node) on the first
  sentence: 2 threads, CPU only, above-normal priority. It loads the model once and holds about 0.5 GB of RAM; it exits
  after 10 idle minutes, when Genio quits, and when its pipe to Genio closes.
  - Each sentence request carries the speaker id of the saved voice, read by Genio's main process per request, so a new
    choice needs no restart of the helper.
  - Measured on the Ryzen 7 5800X: start and model load 2.0 s, then about 1.2 s for a short first sentence; with the
    CPU saturated by other work, 4.8 s and 3.0 s. Later sentences are made while earlier ones play.
- **Stopping** (the mic, Esc, a newer reply): every queued buffer stops at once and every sentence still pending in
  Genio's main process fails; a sentence the helper is already making is dropped when it arrives.
- **The Windows voice stays the fallback**: whenever it is the chosen voice, or the natural voice is missing, declined, still downloading, or
  fails (for the rest of that reply).

### License check (espeak-ng)

Kokoro's weights are Apache-2.0, but sherpa-onnx turns text into phonemes with espeak-ng, which is GPL-3.0-or-later
and is compiled into the addon (`cmake/espeak-ng-for-piper.cmake` builds it as a static library, also in the shared
builds). Genio is MIT. Shipping it this way is fine:

- **Genio never distributes espeak-ng.** The player downloads the addon and the model from their publishers, after a
  yes. GPL-3.0 §2: "You may make, run and propagate covered works that you do not convey, without conditions"; §9:
  "You are not required to accept this License in order to receive or run a copy of the Program." The publishers
  convey it with its source (k2-fsa/sherpa-onnx and the pinned espeak-ng fork, both public).
- **It runs as a separate program.** Only `kokoro-helper.cjs` loads the addon, in its own process; Genio's main
  process and windows send it plain text over a pipe and get PCM back. The GPL FAQ (MereAggregation): "pipes, sockets
  and command-line arguments are communication mechanisms normally used between two separate programs", unless they
  exchange "complex internal data structures".
- **The one module that links it is GPL-compatible.** GPL FAQ (IfLibraryIsGPL): "The software modules that link with
  the library may be under various GPL compatible licenses, but the work as a whole must be licensed under the GPL."
  The helper script is MIT, which the FSF lists as GPL-compatible, so even the helper process taken as one combined work
  (helper plus addon) can be under GPL-3.0, and it only ever comes together on the player's PC.
- Anyone who bundles the addon or the model with Genio has to meet GPL-3.0 for that part (offer espeak-ng's source).
  Genio itself does not bundle them.

## Achievements

- **Say It Out Loud** (`chat-voice`): unlocked by the first recording that types words into the chat box.
- **Natural Voice** (`voice-natural`): unlocked by the first sentence of a reply spoken in the natural voice.

## Code

- `src/main/voice-input.ts`: download, verification, the lazy server, splitting, the prompt and the silence filter.
- `src/main/voice-output.ts`: the natural voice's download, the helper's lifetime, sentence requests and cancel;
  `resources/kokoro-helper.cjs`: the helper process.
- `src/main/window-permissions.ts` and `guardPermissions()` in `src/main/index.ts`: the permission handlers.
- `src/main/ipc.ts`: `voiceStatus`, `voiceInstall`, `voiceTranscribe` and the `voice-install` progress event (the
  status also reports Windows' microphone switch); `voiceOutputStatus`, `voiceOutputInstall`, `voiceOutputDecline`,
  `voiceSynth`, `voiceSynthCancel` and the `voice-output-install` progress event.
- `src/renderer/src/lib/mic.ts` and `mic-worklet.ts`: recording; `src/renderer/src/components/MicButton.tsx`: the
  button, F8 and both consent panels; `src/renderer/src/lib/voice.ts`: speech of replies (the natural voice's queue and
  the Windows voice).

## Later

Not planned for now: speaking during a turn, hands-free listening, a GPU path, other languages, a sample-play button for
the voices, and Codex's realtime voice.
