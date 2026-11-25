import { useRpc, useSettings, type PluginClientContext, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import { elevenLabsClearKey, elevenLabsKeyStatus, elevenLabsSaveKey, elevenLabsVoices } from "../shared/elevenlabs";
import { deviceSettings, voiceSettings, type VoiceSettings } from "../shared/settings";
import { synthesizeSpeech } from "../shared/speech";
import { voiceStatusQueryKey } from "./voice-status";

const PROVIDERS = [
  { value: "paseo", label: "Paseo voice settings" },
  { value: "elevenlabs", label: "ElevenLabs" },
] as const;
const MODELS = [
  { value: "eleven_flash_v2_5", label: "Flash v2.5 (fast, low cost)" },
  { value: "eleven_multilingual_v2", label: "Multilingual v2" },
  { value: "eleven_v4_turbo", label: "v4 Turbo" },
  { value: "eleven_v4", label: "v4" },
  { value: "eleven_v3", label: "v3" },
];
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2].map((speed) => ({ value: String(speed), label: speed.toFixed(1) + "x" }));
const KEY_QUERY = ["read-aloud", "elevenlabs", "key"] as const;
const VOICES_QUERY = ["read-aloud", "elevenlabs", "voices"] as const;

type Theme = PluginSurfaceProps["theme"];
type ReadyVoiceSettings = Extract<SettingsState<typeof voiceSettings.schema>, { status: "ready" }>;
type ElevenLabsValues = VoiceSettings["elevenlabs"];

function Message({ theme, text, error = false }: { theme: Theme; text: string; error?: boolean }) {
  return <Text accessibilityRole={error ? "alert" : undefined}
    style={{ color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>{text}</Text>;
}

function ElevenLabsControls({ settings, theme }: { settings: ReadyVoiceSettings; theme: Theme }) {
  const getKey = useRpc(elevenLabsKeyStatus);
  const saveKey = useRpc(elevenLabsSaveKey);
  const clearKey = useRpc(elevenLabsClearKey);
  const getVoices = useRpc(elevenLabsVoices);
  const queryClient = useQueryClient();
  const keyInput = useRef<SettingsInputHandle>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [search, setSearch] = useState("");
  const [voiceSearch, setVoiceSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setVoiceSearch(search.trim().slice(0, 200)), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const key = useQuery({ queryKey: KEY_QUERY, queryFn: () => getKey({}), retry: false });
  const voices = useQuery({
    queryKey: [...VOICES_QUERY, voiceSearch],
    queryFn: () => getVoices({ search: voiceSearch || undefined }),
    enabled: key.data?.saved === true,
    retry: false,
  });
  const values = settings.values.elevenlabs;
  const account = voices.data?.voices ?? [];
  const options = account.map(({ id, name }) => ({ value: id, label: name }));
  if (values.voiceId && !options.some(({ value }) => value === values.voiceId)) {
    options.unshift({ value: values.voiceId, label: values.voiceName || values.voiceId });
  }
  const edit = (patch: Partial<ElevenLabsValues>) =>
    settings.save({ ...settings.values, elevenlabs: { ...values, ...patch } }, settings.revision);

  async function changeKey(remove: boolean) {
    const apiKey = keyInput.current?.getText().trim();
    if (!remove && !apiKey) return;
    setKeyBusy(true);
    setKeyError("");
    const fallback = remove ? "Could not remove the API key." : "Could not save the API key.";
    try {
      const result = remove ? await clearKey({}) : await saveKey({ apiKey: apiKey ?? "" });
      if (!result.ok) {
        setKeyError("error" in result && typeof result.error === "string" ? result.error : fallback);
        return;
      }
      keyInput.current?.replaceText("");
      setHasDraft(false);
      await key.refetch();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: VOICES_QUERY }),
        queryClient.invalidateQueries({ queryKey: voiceStatusQueryKey }),
      ]);
    } catch {
      setKeyError(fallback);
    } finally {
      setKeyBusy(false);
    }
  }

  const keySource = key.data?.source;
  const keyLabel = key.isPending ? "Checking for an API key..."
    : key.isError ? "Could not check the API key"
    : keySource === "env" ? "Provided by ELEVENLABS_API_KEY on this host"
    : keySource === "file" ? "API key saved on this host" : "No API key saved";
  const hasKey = key.data?.saved === true;
  const unavailable = settings.saving || keyBusy || !hasKey;
  const voiceLoading = !unavailable && voices.isFetching && !voices.data;

  return (
    <>
      <SettingsSection title="ElevenLabs API key">
        <SettingsCard>
          {key.isError ? (
            <SettingsAction label={keyLabel} actionLabel="Retry" onPress={() => void key.refetch()} />
          ) : keySource === "env" || key.isPending ? (
            <Message theme={theme} text={keyLabel} />
          ) : (
            <SettingsInput label="API key" hint={keyLabel} placeholder="Enter API key" secureTextEntry
              ref={keyInput} disabled={keyBusy} onChangeText={(text) => setHasDraft(Boolean(text.trim()))} />
          )}
          {keySource === "none" || keySource === "file" ? (
            <SettingsAction label="Save API key" actionLabel={keyBusy ? "Working..." : "Save"}
              disabled={!hasDraft || keyBusy} onPress={() => void changeKey(false)} />
          ) : null}
          {keySource === "file" ? (
            <SettingsAction label="Remove API key" actionLabel="Remove" disabled={keyBusy}
              onPress={() => void changeKey(true)} />
          ) : null}
        </SettingsCard>
        {keyError ? <Message theme={theme} text={keyError} error /> : null}
      </SettingsSection>
      <SettingsSection title="ElevenLabs voice">
        <SettingsCard>
          <SettingsInput label="Search voices" placeholder="Enter a voice name" disabled={unavailable} onChangeText={setSearch} />
          <SettingsSelect label="Voice" value={values.voiceId} options={options}
            hint={voiceLoading ? "Loading voices..." : !unavailable && !voices.isError && !account.length ? "No matching voices" : undefined}
            disabled={unavailable || !account.length} onValueChange={(voiceId) => {
              const voice = account.find(({ id }) => id === voiceId);
              if (voice) void edit({ voiceId, voiceName: voice.name, agentVoices: values.agentVoices.filter(({ id }) => id !== voiceId) });
            }} />
          {voices.isError && !unavailable ? (
            <SettingsAction label="Could not load voices" error={voices.error.message} actionLabel="Retry"
              onPress={() => void voices.refetch()} />
          ) : null}
          <SettingsSelect label="Model" value={values.model} options={MODELS} disabled={settings.saving}
            onValueChange={(model) => void edit({ model })} />
          <SettingsSelect label="Speed" value={String(values.speed)} options={SPEEDS} disabled={settings.saving}
            onValueChange={(speed) => void edit({ speed: Number(speed) })} />
        </SettingsCard>
      </SettingsSection>
      {account.length && hasKey ? (
        <SettingsSection title="Voices for other agents">
          <SettingsCard>
            {account.map(({ id, name }) => (
              <SettingsSwitch key={id} label={name} hint={id === values.voiceId ? "Main voice" : undefined}
                value={id === values.voiceId || values.agentVoices.some((voice) => voice.id === id)}
                disabled={unavailable || !values.voiceId || id === values.voiceId}
                onValueChange={(enabled) => void edit({
                  agentVoices: enabled ? [...values.agentVoices, { id, name }] : values.agentVoices.filter((voice) => voice.id !== id),
                })} />
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}

function DeviceControls({ theme }: { theme: Theme }) {
  const settings = useSettings(deviceSettings);
  return (
    <SettingsSection title="This device">
      {settings.status === "ready" ? (
        <SettingsCard>
          <SettingsSwitch label="Read new replies automatically" value={settings.values.autoRead}
            disabled={settings.saving} onValueChange={(autoRead) => void settings.save({ autoRead }, settings.revision)} />
        </SettingsCard>
      ) : settings.status === "loading" ? (
        <Message theme={theme} text="Loading settings..." />
      ) : (
        <SettingsCard>
          <SettingsAction label="Could not load device settings" error={settings.error} actionLabel="Reload"
            disabled={settings.saving} onPress={() => void settings.reload()} />
          {settings.status === "invalid" ? (
            <SettingsAction label="Restore default device settings" actionLabel="Reset"
              disabled={settings.saving} onPress={() => void settings.reset()} />
          ) : null}
        </SettingsCard>
      )}
      {settings.saveError ? <Message theme={theme} text={settings.saveError} error /> : null}
    </SettingsSection>
  );
}

export function createVoiceSettingsScreen(client: PluginClientContext) {
  return function VoiceSettingsScreen({ theme }: PluginSurfaceProps) {
    const settings = useSettings(voiceSettings);
    const speak = useRpc(synthesizeSpeech);
    const [testing, setTesting] = useState(false);
    const [testError, setTestError] = useState("");

    async function testVoice() {
      setTesting(true);
      setTestError("");
      try {
        const audio = await speak({ text: "Hello. This is how your Read Aloud voice sounds." });
        await client.playAudio(audio);
      } catch (error) {
        setTestError(error instanceof Error ? error.message : "Could not play the test voice.");
      } finally {
        setTesting(false);
      }
    }

    return (
      <>
        <SettingsSection title="Voice source">
          {settings.status === "ready" ? (
            <SettingsCard>
              <SettingsSelect label="Voice source" value={settings.values.provider} options={PROVIDERS}
                disabled={settings.saving} onValueChange={(provider) => {
                  setTestError("");
                  void settings.save({ ...settings.values, provider }, settings.revision);
                }} />
            </SettingsCard>
          ) : settings.status === "loading" ? (
            <Message theme={theme} text="Loading settings..." />
          ) : (
            <SettingsCard>
              <SettingsAction label="Could not load settings" error={settings.error} actionLabel="Reload"
                disabled={settings.saving} onPress={() => void settings.reload()} />
              {settings.status === "invalid" ? (
                <SettingsAction label="Restore default voice settings" actionLabel="Reset"
                  disabled={settings.saving} onPress={() => void settings.reset()} />
              ) : null}
            </SettingsCard>
          )}
          {settings.saveError ? (
            <SettingsAction label="Could not save settings" error={settings.saveError} actionLabel="Reload"
              disabled={settings.saving} onPress={() => void settings.reload()} />
          ) : null}
        </SettingsSection>
        {settings.status === "ready" && settings.values.provider === "elevenlabs" ? (
          <ElevenLabsControls settings={settings} theme={theme} />
        ) : null}
        {settings.status === "ready" ? (
          <SettingsSection title="Preview">
            <SettingsCard>
              <SettingsAction label="Test voice" actionLabel={testing ? "Testing..." : "Play"}
                disabled={testing || settings.saving} error={testError || undefined} onPress={() => void testVoice()} />
            </SettingsCard>
          </SettingsSection>
        ) : null}
        <DeviceControls theme={theme} />
      </>
    );
  };
}
