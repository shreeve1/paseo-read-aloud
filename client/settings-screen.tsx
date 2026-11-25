import { useRpc, useSettings, type PluginClientContext, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Text } from "react-native";
import { elevenLabsClearKey, elevenLabsKeyStatus, elevenLabsSaveKey, elevenLabsVoices } from "../shared/elevenlabs";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };
import { DIRECT_VOICE_UNAVAILABLE, managedVoices, type ManagedStatus } from "../shared/managed";
import { deviceSettings, voiceSettings, type VoiceSettings } from "../shared/settings";
import { synthesizeSpeech } from "../shared/speech";
import { voiceModeConnect, voiceModeStatus } from "../shared/voice-mode";
import { canTestVoice, reconcileManagedVoice, voiceSources } from "./managed-settings";
import { useManagedStatus, useVoiceStatus, voiceStatusQueryKey } from "./voice-status";

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

function ElevenLabsControls({ settings, theme, testAction }: { settings: ReadyVoiceSettings; theme: Theme; testAction: ReactNode }) {
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
  const refreshing = !unavailable && voices.isFetching && Boolean(voices.data);

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
          <SettingsAction label="Voice list" hint="Loads voices added in the ElevenLabs console"
            actionLabel={refreshing ? "Refreshing..." : "Refresh"} disabled={unavailable || voices.isFetching}
            onPress={() => void queryClient.invalidateQueries({ queryKey: VOICES_QUERY })} />
          {voices.isError && !unavailable ? (
            <SettingsAction label="Could not load voices" error={voices.error.message} actionLabel="Retry"
              onPress={() => void voices.refetch()} />
          ) : null}
          <SettingsSelect label="Model" value={values.model} options={MODELS} disabled={settings.saving}
            onValueChange={(model) => void edit({ model })} />
          <SettingsSelect label="Speed" value={String(values.speed)} options={SPEEDS} disabled={settings.saving}
            onValueChange={(speed) => void edit({ speed: Number(speed) })} />
          {testAction}
        </SettingsCard>
      </SettingsSection>
      <VoiceModeControls theme={theme} />
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

function VoiceModeControls({ theme }: { theme: Theme }) {
  const getStatus = useRpc(voiceModeStatus);
  const connect = useRpc(voiceModeConnect);
  const status = useQuery({
    queryKey: ["read-aloud", "voice-mode.status"],
    queryFn: () => getStatus({}),
    retry: false,
  });
  const change = useMutation({
    mutationFn: async (enabled: boolean) => {
      const result = await connect({ enabled });
      if (!result.ok) throw new Error(result.error ?? "Could not change Paseo's Speaking settings.");
    },
    onSettled: () => status.refetch(),
  });

  const connected = status.data?.connected ?? false;
  const bridge = status.data?.listening ? "The speech bridge is listening on this host."
    : status.data?.error ? "The speech bridge could not start."
    : status.isPending ? "Checking the speech bridge..." : "The speech bridge is not listening.";
  const hint = status.isError ? undefined
    : connected ? bridge + " Paseo's Speaking settings show the local Base URL." : bridge;
  const error = change.error?.message ?? (status.isError
    ? "Could not check Paseo's Speaking settings." : status.data?.error);

  return (
    <SettingsSection title="Paseo Voice mode">
      <SettingsCard>
        <SettingsSwitch label="Use this voice in Voice mode" value={connected} hint={hint}
          disabled={change.isPending || status.isFetching || status.isError || (!connected && !status.data?.listening)}
          onValueChange={(enabled) => change.mutate(enabled)} />
        {status.isError ? (
          <SettingsAction label="Check bridge status" actionLabel="Retry"
            onPress={() => void status.refetch()} />
        ) : null}
      </SettingsCard>
      {error ? <Message theme={theme} text={error} error /> : null}
    </SettingsSection>
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

function ManagedVoicePicker({ hostId, settings, theme }: {
  hostId: string; settings: ReadyVoiceSettings; theme: Theme;
}) {
  const getVoices = useRpc(managedVoices);
  const voices = useQuery({
    queryKey: ["read-aloud", "managed.voices", hostId],
    queryFn: () => getVoices({}),
    refetchOnMount: "always",
    retry: false,
  });
  const { data: speech } = useVoiceStatus(hostId);
  const unavailableVoiceId = speech?.unavailableVoiceId;
  const available = voices.isSuccess && voices.isFetchedAfterMount
    ? voices.data.voices.filter(({ id }) => id !== unavailableVoiceId)
    : undefined;
  const saved = settings.values.managed;
  const selection = reconcileManagedVoice(saved, available, unavailableVoiceId);

  useEffect(() => {
    if (selection !== saved && (!voices.isFetching || saved.voiceId === unavailableVoiceId) &&
        !settings.saving && !settings.saveError) {
      void settings.save({ ...settings.values, managed: selection }, settings.revision);
    }
  }, [saved, selection, settings, unavailableVoiceId, voices.isFetching]);

  return (
    <SettingsCard>
      <SettingsSelect label="Voice" value={selection.voiceId}
        options={(available ?? []).map(({ id, name }) => ({ value: id, label: name }))}
        hint={voices.isFetching && !available ? "Loading voices..." : available?.length === 0 ? "No approved voices are available" : undefined}
        disabled={settings.saving || voices.isFetching || !available?.length}
        onValueChange={(voiceId) => {
          const voice = available?.find(({ id }) => id === voiceId);
          if (voice) void settings.save({
            ...settings.values, managed: { voiceId: voice.id, voiceName: voice.name },
          }, settings.revision);
        }} />
      <SettingsAction label="Approved voices" actionLabel={voices.isFetching ? "Refreshing..." : "Refresh"}
        disabled={voices.isFetching} onPress={() => void voices.refetch()} />
      {voices.isError ? <Message theme={theme} text={voices.error.message} error /> : null}
    </SettingsCard>
  );
}

function ManagedVoiceControls({ status, hostId, settings, theme }: {
  status: Exclude<ManagedStatus, { mode: "personal" }>; hostId: string; settings: ReadyVoiceSettings; theme: Theme;
}) {
  return (
    <SettingsSection title="Central voice">
      {status.mode === "managed-unavailable" ? <Message theme={theme} text={status.reason} error /> : (
        <>
          <ManagedVoicePicker hostId={hostId} settings={settings} theme={theme} />
          <Message theme={theme} text={`For the pilot, press the speaker under a reply that says “${protocol.pilot.fixture_text}”`} />
        </>
      )}
    </SettingsSection>
  );
}

export function createVoiceSettingsScreen(client: PluginClientContext) {
  return function VoiceSettingsScreen({ theme, host }: PluginSurfaceProps) {
    const settings = useSettings(voiceSettings);
    const mode = useManagedStatus(host.id);
    const status = mode.isSuccess && mode.isFetchedAfterMount ? mode.data : undefined;
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

    const testAction = canTestVoice(status?.mode) ? (
      <SettingsAction label="Test voice" actionLabel={testing ? "Testing..." : "Play"}
        disabled={testing || settings.saving} error={testError || undefined} onPress={() => void testVoice()} />
    ) : null;
    const personal = status?.mode === "personal";
    const provider = settings.status === "ready" ? settings.values.provider : undefined;
    const options = status ? voiceSources(status.mode) : [];
    const selected = options.some(({ value }) => value === provider) ? provider : undefined;
    const elevenLabs = personal && settings.status === "ready" && settings.values.provider === "elevenlabs";

    return (
      <>
        <SettingsSection title="Voice source">
          {mode.isError ? (
            <SettingsCard>
              <SettingsAction label="Could not check which voice sources are available" actionLabel="Retry"
                onPress={() => void mode.refetch()} />
            </SettingsCard>
          ) : settings.status === "loading" || !status ? (
            <Message theme={theme} text="Loading settings..." />
          ) : settings.status === "ready" ? (
            <SettingsCard>
              <SettingsSelect label="Voice source" value={selected ?? ""} options={options}
                disabled={settings.saving} onValueChange={(provider) => {
                  if (!provider) return;
                  setTestError("");
                  void settings.save({ ...settings.values, provider }, settings.revision);
                }} />
              {!selected && provider === "elevenlabs" ? <Message theme={theme} text={DIRECT_VOICE_UNAVAILABLE} /> : null}
              {!selected && provider === "managed" ? (
                <Message theme={theme} text="Central voice is unavailable on this host. Choose a voice source above." />
              ) : null}
            </SettingsCard>
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
        {status && status.mode !== "personal" && status.speakingProblem ? (
          <Message theme={theme} text={status.speakingProblem} error />
        ) : null}
        {elevenLabs ? <ElevenLabsControls settings={settings} theme={theme} testAction={testAction} /> : null}
        {status && status.mode !== "personal" && settings.status === "ready" && provider === "managed" ? (
          <ManagedVoiceControls status={status} hostId={host.id} settings={settings} theme={theme} />
        ) : null}
        {testAction && settings.status === "ready" && provider === "paseo" ? (
          <SettingsSection title="Preview">
            <SettingsCard>{testAction}</SettingsCard>
          </SettingsSection>
        ) : null}
        {personal ? <DeviceControls theme={theme} /> : null}
      </>
    );
  };
}
