# Read Aloud for Paseo

A [Paseo](https://paseo.sh) plugin that adds a speaker button under each finished agent reply.
Press it to hear the reply. Press again to stop. On a managed host, choose a Central voice or
use Paseo's local voice. On a personal install, choose Google Chirp 3 HD or follow Paseo's voice settings.

![Read Aloud button under a reply](assets/screenshot.png)

## Install

Use this checkout with Paseo 0.17.0 or later:

```sh
paseo plugin add /absolute/path/to/paseo-read-aloud
```

## Choose a voice

On a personal install, open **Settings > Plugins** and select the cog next to **Read Aloud**.

- To follow Paseo, leave **Voice source** set to **Paseo voice settings**. For local speech, download
  a voice in **Settings > Voice** first.
- To use Google Cloud Text-to-Speech, select **Google** and [set up a key](#set-up-google).
- To give agents different voices, add them under **Voices for other agents**.
  Each agent gets a consistent voice while that list stays the same.
- To hear new replies without pressing the button, turn on **Read new replies automatically**.
  This setting applies only to this device and only to open chats.

## Set up Google

1. In the Google Cloud console, select a project with billing enabled.
2. Under **APIs & Services**, enable the **Cloud Text-to-Speech API**.
3. Under **Credentials**, choose **Create credentials > API key**. Restrict the key to the
   **Cloud Text-to-Speech API**.
4. In Read Aloud settings, paste the key and select **Save**. Choose a voice, then select
   **Play** under **Test voice**.

Read Aloud saves the key on the daemon host in `<paseo-home>/plugin-data/read-aloud/google-key`.
Set `GOOGLE_TTS_API_KEY` in the daemon environment to override the saved key.
Google includes the first 1 million Chirp 3 HD characters per month at no charge, then
[charges US$30 per million characters](https://cloud.google.com/text-to-speech/pricing).
Read Aloud sends the cleaned reply text to Google. See [Data in the overview](OVERVIEW.md#data).

If you upgrade from the previous direct voice provider, Read Aloud selects Google and resets
the voice and speed to Google's defaults. Set up a Google key before using direct speech again.

## Central voice on a managed host

New hosted installs start on **Local voice**. If your company has approved Central voice
for your login, open **Settings > Plugins > Read Aloud** and select **Central voice**. Search
for an approved Google Chirp 3 HD voice by name and choose a **Speed**. Speeds other than 1×
require FFmpeg on the Paseo host. You do not need a Google key.

With Central voice selected, pressing the speaker on a finished reply sends the text to Google
to make audio. **Test voice > Play** sends only “The blue notebook is on the shelf.” Both use
your saved speed and count toward the monthly limits for your login and company. Refreshing
voices sends no reply text. Switch to **Local voice** at any time to use a downloaded voice from
**Settings > Voice**. Paseo Voice mode stays local.

The earlier pilot remains limited to the fixed sample, even from the reply speaker. Your
administrator manages which mode is available. See the [hub protocol](shared/hub-protocol-v1.json)
for the required host files and credential helper.

## Voice mode on a personal install

With **Google** selected, turn on **Use this voice in Voice mode** to hear Paseo Voice mode
replies in your main Read Aloud voice. The switch changes Paseo's **Speaking** provider to
**OpenAI** and points its **Base URL** at the speech bridge on the daemon host. Each Linux user
gets a port based on their user ID. If the port is in use, set `READ_ALOUD_BRIDGE_PORT` in that
daemon's environment to an unused port from 1024 to 65535 before starting it.

The bridge listens only on the daemon host. It accepts speech requests only when they carry
your Paseo **Speaking** key. The switch keeps an existing OpenAI key or creates a private key
when needed. The bridge sends the speech text to Google. Listening settings stay the same.
Turn the switch on again after upgrading from 0.4.0 or changing the port.

Turn the switch off before disabling Read Aloud. It clears the Base URL if you started with
OpenAI, or restores the Local provider if you started with Local. If you disable the plugin first,
Voice mode cannot speak until you re-enable it or change the **Speaking** settings in Paseo.

## Layout

| Path | What it does |
| --- | --- |
| `index.server.ts`, `server/` | Adds reply rows and generates speech using the host's configured mode |
| `index.client.tsx`, `client/` | Settings screen, reply button, and playback |
| `shared/` | Settings and request shapes shared by the client and daemon |
| `shared/text.ts` | Markdown-to-speech cleanup and chunking (no dependencies) |
| `test/` | Tests for text, playback, settings, and cloud requests with fake responses |

## Develop

```sh
npm ci
npm run typecheck
npm test
```

Tests use Node's built-in TypeScript support and OpenSSL for disposable certificates. They do not need an API key.

## License

MIT
