# Read Aloud

Adds a small speaker button under each finished agent reply. Pressing it reads
the reply out loud; pressing it again stops.

## How it works

When a turn completes, the plugin adds a button row below the turn's final
reply. The reply itself is still drawn by Paseo, with its normal Markdown and
copy button.

Before speaking, the reply is turned into plain speech: code blocks are
announced as "code block", links are read as their text, and Markdown marks,
table pipes and emoji are dropped (characters inside words, like snake_case or
C#, are kept). The text is spoken a sentence or two at a time.

Read Aloud prepares and plays short clips:

- The first part is short so playback can start sooner.
- Local voices are loaded as soon as a chat is open, and the first part is
  prepared when you touch the button (or hover over it for a moment on
  desktop), before the press finishes.
- Read Aloud trims padding silence from WAV clips and queues the next clip
  shortly before the current clip ends. OpenAI-compatible endpoints that reject
  raw audio fall back to MP3, where a short gap can remain.
- Stopping drops any parts still waiting to be prepared, so the next press
  isn't held up behind them.

When **Voice source** is set to **Paseo voice settings**, Read Aloud uses the
same voice as Paseo's voice mode. It checks voice environment variables, then
**Settings > Voice**, then Paseo's default voice.

- Local: whichever downloaded voice is selected (Kokoro, Kokoro Lite, Kitten or
  Piper), with its speaker and speed. Voice files are located through Paseo's
  own model catalog and run by Paseo's own speech runtime, with a bundled
  WebAssembly copy as a fallback.
- OpenAI: the configured OpenAI-compatible speech endpoint, key, model and
  voice.

When **Voice source** is **ElevenLabs**, Read Aloud uses your selected account
voice, model, and speed. If you add voices under **Voices for other agents**,
each agent gets a consistent voice from the main voice and your selections.
Changing the list can change which voice an agent gets. **Test voice** uses
the main voice.

Paseo plays the audio on the device that starts playback.

## Setup

Open **Settings > Plugins** and select the cog next to **Read Aloud**. To use
ElevenLabs, select that source, save an API key, and choose a voice. A daemon
environment key takes priority over a saved key. For local speech, download the
selected voice in **Settings > Voice**.

**Read new replies automatically** is off by default. Turn it on for each device
where you want it. It reads replies that appear in open chats within 20 seconds
of completion, provided no reply is already playing. A browser can block
automatic playback until you interact with the page. You can still press the
speaker button yourself.

## Voice mode

With **ElevenLabs** selected, turn on **Use this voice in Voice mode** to hear
Paseo Voice mode replies in your main Read Aloud voice. The switch sets
Paseo's **Speaking** provider to **OpenAI** and points its **Base URL** at
the speech bridge. The bridge listens only on `127.0.0.1` on the daemon host
and sends Voice mode speech text to ElevenLabs.

Turn the switch off before disabling the plugin. This clears the Base URL
or restores the Local provider if you were using it before. If you disable
the plugin first, Voice mode cannot speak until you re-enable the plugin or
change Paseo's **Speaking** settings.

## Data

Local speech generates audio on the daemon host and sends the finished audio to
the client for playback. OpenAI and ElevenLabs receive the cleaned reply text
in short chunks. ElevenLabs also receives the text of adjacent chunks to help
keep the delivery consistent. If a model rejects that extra text, Read Aloud
retries without it. Cloud requests can start when you press the speaker button,
test a voice, or enable automatic reading and a new reply arrives. Touching
without pressing or hovering only prepares audio for local voices.

The plugin sends the ElevenLabs key to ElevenLabs to validate it, list account
voices, and generate speech. It does not send the saved key back to connected
clients. The key comes from the daemon's `ELEVENLABS_API_KEY` environment variable
or lives in `<paseo-home>/plugin-data/read-aloud/elevenlabs-key`. On systems that
support Unix permissions, the directory is private to the daemon user
(`0700`) and the key file is readable and writable only by that user (`0600`).
Other voice settings are shared by clients connected to that host. The auto-read
setting stays on the device.

## Limitations

- One reply is read at a time; starting another stops the current one.
- Paseo can't cut a clip off mid-way, so Stop takes effect at the end of the
  part currently playing (usually a few seconds). The button shows it is
  stopping until then.
- Reading carries on if you scroll the reply out of view.
- About 20,000 characters of a reply are read per press.
- The selected voice and model determine which languages are available.
- Replies that finished before the plugin was enabled have no speaker button.
