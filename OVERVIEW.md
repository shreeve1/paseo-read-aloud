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
- Local voices are loaded when a chat opens. On personal installs, Read Aloud
  prepares the first local clip when you touch the button or hover over it
  on desktop.
- Read Aloud trims padding silence from local and raw audio clips. For WAV
  playback, it queues the next clip shortly before the current clip ends.
  OpenAI-compatible endpoints that reject raw audio fall back to MP3, where a
  short gap can remain.
- Stopping drops any parts still waiting to be prepared, so the next press
  isn't held up behind them.

On a personal install, **Paseo voice settings** uses the same voice as
Paseo's Voice mode. Read Aloud checks the voice environment variables, then
**Settings > Voice**, then Paseo's default voice.

- Local: whichever downloaded voice is selected (Kokoro, Kokoro Lite, Kitten or
  Piper), with its speaker and speed. Voice files are located through Paseo's
  own model catalog and run by Paseo's own speech runtime, with a bundled
  WebAssembly copy as a fallback.
- OpenAI: the configured OpenAI-compatible speech endpoint, key, model and
  voice.

When **Voice source** is **Google**, Read Aloud uses your selected Chirp 3 HD
voice and speed. If you add voices under **Voices for other agents**,
each agent gets a consistent voice from the main voice and your selections.
Changing the list can change which voice an agent gets. **Test voice** uses
the main voice.

Paseo plays the audio on the device that starts playback.

## Managed hosts

New hosted logins start with **Local voice**. An administrator can make **Central voice**
available after your company opts in and the hub grants access to your login. In Read Aloud
settings, search by name, choose an approved Google Chirp 3 HD voice, and set its speed.
Speeds other than 1× require FFmpeg with the `atempo` filter on the host.

Press the speaker beside a finished reply to read it. With Central voice selected, the reply
text goes to Google to make audio. **Test voice > Play** reads only “The blue notebook is on
the shelf.” The earlier pilot can also play the fixed sample from the speaker and rejects all
other replies. Playback and previews count toward the login and company limits. Refreshing
voices does not send reply text.

Managed hosts never read replies automatically. Paseo Voice mode keeps speaking and listening
local. If Speaking still points to the personal speech bridge, Read Aloud attempts to restore
the previous setting and shows a warning if it cannot confirm the restore.

At startup and reload, Read Aloud checks for a standard profile for the operating system login.
Root must own the profile directories and files. Read Aloud rejects symbolic links and
group- or world-writable entries. An invalid profile leaves speech Local. When the login has no
standard profile, Read Aloud checks the legacy managed configuration, then uses personal mode if
that configuration is absent. See the [hub protocol](shared/hub-protocol-v1.json) for file formats.

## Personal setup

Open **Settings > Plugins** and select the cog next to **Read Aloud**.
For local speech, download the selected voice in **Settings > Voice**.

To use Google, select a Google Cloud project with billing enabled. In
**APIs & Services**, enable the **Cloud Text-to-Speech API**. Under
**Credentials**, create an API key and restrict it to that API. Select
**Google** in Read Aloud settings, save the key, and choose a voice.
Google includes the first 1 million Chirp 3 HD characters per month at no
charge, then [charges US$30 per million characters](https://cloud.google.com/text-to-speech/pricing).

**Read new replies automatically** is off by default. Turn it on for each device
where you want it. It reads replies that appear in open chats within 20 seconds
of completion, provided no reply is already playing. A browser can block
automatic playback until you interact with the page. You can still press the
speaker button yourself.

## Voice mode on a personal install

With **Google** selected, turn on **Use this voice in Voice mode** to hear
Paseo Voice mode replies in your main Read Aloud voice. The switch sets
Paseo's **Speaking** provider to **OpenAI** and points its **Base URL** at
the speech bridge. Each Linux user gets a port based on their user ID.
The bridge listens only on the daemon host and accepts requests only when
they carry your Paseo **Speaking** key. It sends Voice mode speech text
to Google.

Turn the switch off before disabling the plugin. This clears the Base URL
or restores the Local provider if you were using it before. If you disable
the plugin first, Voice mode cannot speak until you re-enable the plugin or
change Paseo's **Speaking** settings.

## Data

Local speech generates audio on the daemon host and sends the finished audio to
the client for playback. For Central voice, the daemon verifies the private hub's
certificate and host name before sending the existing hosted login credential
and the current text chunk. Adjacent chunks stay on the daemon. The plugin does
not store another copy of the credential, start a speech bridge, or call a
speech provider directly. The hub checks access and limits at every request and retains the
fixed sample restriction for the pilot.

On a personal install, OpenAI and Google receive the cleaned reply text
in short chunks. Cloud requests can start when you press the speaker button,
test a voice, or enable automatic reading and a new reply arrives. Touching
without pressing or hovering only prepares audio for local voices.

The plugin sends the Google key to Google to validate it, list voices, and
generate speech. It does not send the saved key back to connected clients.
The daemon's `GOOGLE_TTS_API_KEY` environment variable takes priority over
`<paseo-home>/plugin-data/read-aloud/google-key`. On systems that
support Unix permissions, the directory is private to the daemon user
(`0700`) and the key file is readable and writable only by that user (`0600`).
Other voice settings are shared by clients connected to that host. The auto-read
setting stays on the device.

## Limitations

- One reply is read at a time; starting another stops the current one.
- **Stop** cancels a Central voice wait, drops any late audio, and sends no more text. A
  request the hub already accepted can finish. Paseo cannot interrupt a clip it has already
  started, so **Stopping** stays visible until the current clip ends.
- Reading carries on if you scroll the reply out of view.
- Read Aloud plays up to about 20,000 characters of a reply per press.
- The selected voice and model determine which languages are available.
- Replies that finished before the plugin was enabled have no speaker button.
