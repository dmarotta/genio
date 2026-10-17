# Voice

Talk to Genio's chat and hear its replies, all on this PC: nothing is sent anywhere, nothing costs money, and there is
no voice setting beyond the existing **Read replies aloud**.

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

- **Settings → General → Read replies aloud** (off by default). Genio speaks the last text of each successful main
  chat turn with the system voice (Windows' OneCore voices start in under 0.15 s).
- What is spoken: code blocks become "code block omitted", tables are skipped, URLs become "link", file paths become
  "path", and a long reply is cut at a sentence end near 600 characters.
- **Pressing the mic, or Esc in the chat box, stops it.** A newer reply replaces an older one.
- Tool calls, permission asks and system lines are never spoken. **The Bot never speaks**, and sending any message
  still ends AFK as typed text does.

## Achievement

**Say It Out Loud** (`chat-voice`): unlocked by the first recording that types words into the chat box.

## Code

- `src/main/voice-input.ts`: download, verification, the lazy server, splitting, the prompt and the silence filter.
- `src/main/window-permissions.ts` and `guardPermissions()` in `src/main/index.ts`: the permission handlers.
- `src/main/ipc.ts`: `voiceStatus`, `voiceInstall`, `voiceTranscribe` and the `voice-install` progress event; the
  status also reports Windows' microphone switch.
- `src/renderer/src/lib/mic.ts` and `mic-worklet.ts`: recording; `src/renderer/src/components/MicButton.tsx`: the
  button, F8 and the consent panel; `src/renderer/src/lib/voice.ts`: speech of replies.

## Later

A natural local voice for replies (Kokoro, opt-in) is the next step. Not planned for now: hands-free listening, a GPU
path, other languages and Codex's realtime voice.
