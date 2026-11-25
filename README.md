# Read Aloud for Paseo

A [Paseo](https://paseo.sh) plugin that adds a speaker button under each finished agent reply.
Press it to hear the reply. Press again to stop. On a managed host, choose a Central voice or
use Paseo's local voice. On a personal install, use ElevenLabs directly or follow Paseo's voice settings.

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
- To use ElevenLabs, select **ElevenLabs**. Enter an API key with access to voice lookup and
  text to speech, then select **Save**. If the Paseo daemon already has an `ELEVENLABS_API_KEY`
  environment variable, Read Aloud uses that key. Pick a voice and select **Play** under **Test voice**.
- To give agents different voices, turn on the voices you want under **Voices for other agents**.
  Each agent gets a consistent voice while that list stays the same.
- To hear new replies without pressing the button, turn on **Read new replies automatically**.
  This setting applies only to this device and only to open chats.

Read Aloud saves the ElevenLabs key on the daemon host in
`<paseo-home>/plugin-data/read-aloud/elevenlabs-key`. See [the overview](OVERVIEW.md#data) for which
providers receive reply text.

## Central voice on a managed host

Open **Settings > Plugins > Read Aloud**. Select **Central voice** and choose an approved voice.
You don't need an ElevenLabs key. **Refresh** checks the current list and clears your selection
if the voice was removed. If Central voice can't play, select **Paseo voice settings (local)**
and use a downloaded voice from **Settings > Voice**.

Managed Read Aloud plays on demand. During the pilot, press the speaker under a reply that
says “The blue notebook is on the shelf.” Automatic reading and **Test voice** are unavailable.
Paseo's separate Voice mode uses its own local speaking and listening settings in the pilot.

Your administrator sets up the private service. See the [hub protocol](shared/hub-protocol-v1.json)
for the required host files and credential helper.

## Voice mode on a personal install

With **ElevenLabs** selected, turn on **Use this voice in Voice mode** to hear Paseo Voice mode
replies in your main Read Aloud voice. The switch changes Paseo's **Speaking** provider to
**OpenAI** and points its **Base URL** at the speech bridge on the daemon host. Each Linux user
gets a port based on their user ID. If the port is in use, set `READ_ALOUD_BRIDGE_PORT` in that
daemon's environment to an unused port from 1024 to 65535 before starting it.

The bridge listens only on the daemon host. It accepts speech requests only when they carry
your Paseo **Speaking** key. The switch keeps an existing OpenAI key or creates a private key
when needed. The bridge sends the speech text to ElevenLabs. Listening settings stay the same.
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
