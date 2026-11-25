# Read Aloud for Paseo

A [Paseo](https://paseo.sh) plugin that adds a speaker button under each finished agent reply.
Press it to hear the reply. Press again to stop. Read Aloud can use an ElevenLabs voice or follow
Paseo's own voice settings for local speech or OpenAI.

![Read Aloud button under a reply](assets/screenshot.png)

## Install

Use this checkout with Paseo 0.17.0 or later:

```sh
paseo plugin add /absolute/path/to/paseo-read-aloud
```

## Choose a voice

Open **Settings > Plugins** and select the cog next to **Read Aloud**.

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

## Voice mode

With **ElevenLabs** selected, turn on **Use this voice in Voice mode** to hear Paseo Voice mode
replies in your main Read Aloud voice. The switch changes Paseo's **Speaking** provider to
**OpenAI** and sets its **Base URL** to `http://127.0.0.1:8390/v1`. The bridge listens only on
`127.0.0.1` on the daemon host and sends speech requests to ElevenLabs. Listening settings stay
the same.

Turn the switch off before disabling Read Aloud. It clears the Base URL if you started with
OpenAI, or restores the Local provider if you started with Local. If you disable the plugin first,
Voice mode cannot speak until you re-enable it or change the **Speaking** settings in Paseo.

## Layout

| Path | What it does |
| --- | --- |
| `index.server.ts`, `server/` | Adds reply rows, stores the ElevenLabs key, and generates speech |
| `index.client.tsx`, `client/` | Settings screen, reply button, and playback |
| `shared/` | Settings and request shapes shared by the client and daemon |
| `shared/text.ts` | Markdown-to-speech cleanup and chunking (no dependencies) |
| `test/` | Tests for text, playback, settings, and cloud requests with fake responses |

## Develop

```sh
npm install
npm run typecheck
npm test
```

Tests use Node's built-in TypeScript support and do not need an API key.

## License

MIT
