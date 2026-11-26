import { useRpc, useSettings, type PluginClientContext, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch, type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text } from "react-native";
import protocol from "../shared/hub-protocol-v1.json" with { type: "json" };
import { googleClearKey, googleKeyStatus, googleSaveKey, googleVoices } from "../shared/google";
import { DIRECT_VOICE_UNAVAILABLE, managedVoices } from "../shared/managed";
import { deviceSettings, managedSpeed, VOICE_SPEEDS, voiceSettings, type VoiceSettings } from "../shared/settings";
import { synthesizeSpeech } from "../shared/speech";
import { voiceModeConnect, voiceModeStatus } from "../shared/voice-mode";
import { reconcileManagedVoice, voicePickerOptions, voiceSources } from "./managed-settings";
import { createVoicePreview } from "./voice-preview";
import { useManagedStatus, useVoiceStatus, voiceStatusQueryKey } from "./voice-status";

const SPEEDS = VOICE_SPEEDS.map((speed) => ({ value: String(speed), label: speed + "x" }));
const KEY_QUERY = ["read-aloud", "google", "key"] as const;
const VOICES_QUERY = ["read-aloud", "google", "voices", "en-US"] as const;

type Theme = PluginSurfaceProps["theme"];
type ReadyVoiceSettings = Extract<SettingsState<typeof voiceSettings.schema>, { status: "ready" }>;
type GoogleValues = VoiceSettings["google"];

function Message({ theme, text, error = false }: { theme: Theme; text: string; error?: boolean }) {
  return <Text accessibilityRole={error ? "alert" : undefined}
    style={{ color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>{text}</Text>;
}

function GoogleControls({ settings, theme, testAction }: { settings: ReadyVoiceSettings; theme: Theme; testAction: ReactNode }) {
  const getKey = useRpc(googleKeyStatus);
  const saveKey = useRpc(googleSaveKey);
  const clearKey = useRpc(googleClearKey);
  const getVoices = useRpc(googleVoices);
  const queryClient = useQueryClient();
  const keyInput = useRef<SettingsInputHandle>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [search, setSearch] = useState("");

  const key = useQuery({ queryKey: KEY_QUERY, queryFn: () => getKey({}), retry: false });
  const voices = useQuery({
    queryKey: VOICES_QUERY,
    queryFn: () => getVoices({}),
    enabled: key.data?.saved === true,
    retry: false,
  });
  const values = settings.values.google;
  const available = voices.data?.voices ?? [];
  const currentVoice = available.find(({ id }) => id === values.voiceName);
  const { matching, options: mainOptions } = voicePickerOptions(available, values.voiceName, search);
  const extraOptions = matching.filter(({ id }) =>
    id !== values.voiceName && !values.agentVoices.some((voice) => voice.id === id))
    .map(({ id, name }) => ({ value: id, label: name }));
  const edit = (patch: Partial<GoogleValues>) =>
    settings.save({ ...settings.values, google: { ...values, ...patch } }, settings.revision);

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
    : keySource === "env" ? "Provided by GOOGLE_TTS_API_KEY on this host"
    : keySource === "file" ? "API key saved on this host" : "No API key saved";
  const hasKey = key.data?.saved === true;
  const unavailable = settings.saving || keyBusy || !hasKey;
  const voiceLoading = !unavailable && voices.isFetching && !voices.data;
  const refreshing = !unavailable && voices.isFetching && Boolean(voices.data);

  return (
    <>
      <SettingsSection title="Google API key">
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
      <SettingsSection title="Google Chirp 3 HD voice">
        <SettingsCard>
          {!currentVoice && values.voiceName ? (
            <Message theme={theme} text={`Current voice: ${values.voiceLabel || values.voiceName}`} />
          ) : null}
          <SettingsInput label="Search by voice name" placeholder="Enter a name" disabled={unavailable} onChangeText={setSearch} />
          <SettingsSelect label="Voice" value={currentVoice?.id ?? ""} options={mainOptions}
            hint={voiceLoading ? "Loading voices..." : !unavailable && !voices.isError && !matching.length ? "No matching voices" : undefined}
            disabled={unavailable || !matching.length} onValueChange={(voiceName) => {
              const voice = matching.find(({ id }) => id === voiceName);
              if (voice) void edit({ voiceName, voiceLabel: voice.name, agentVoices: values.agentVoices.filter(({ id }) => id !== voiceName) });
            }} />
          <SettingsAction label="Voice list"
            actionLabel={refreshing ? "Refreshing..." : "Refresh"} disabled={unavailable || voices.isFetching}
            onPress={() => void queryClient.invalidateQueries({ queryKey: VOICES_QUERY })} />
          {voices.isError && !unavailable ? (
            <SettingsAction label="Could not load voices" error={voices.error.message} actionLabel="Retry"
              onPress={() => void voices.refetch()} />
          ) : null}
          <SettingsSelect label="Speed" value={String(values.speed)} options={SPEEDS} disabled={settings.saving}
            onValueChange={(speed) => void edit({ speed: Number(speed) })} />
          {testAction}
        </SettingsCard>
      </SettingsSection>
      <VoiceModeControls theme={theme} />
      {hasKey ? (
        <SettingsSection title="Voices for other agents">
          <SettingsCard>
            <SettingsSelect label="Add a voice" value="" options={extraOptions}
              disabled={unavailable || !extraOptions.length || !values.voiceName}
              onValueChange={(id) => {
                const voice = matching.find((item) => item.id === id);
                if (voice) void edit({ agentVoices: [...values.agentVoices, voice] });
              }} />
            {values.agentVoices.map(({ id, name }) => (
              <SettingsSwitch key={id} label={name} value disabled={unavailable}
                onValueChange={(enabled) => {
                  if (!enabled) void edit({ agentVoices: values.agentVoices.filter((voice) => voice.id !== id) });
                }} />
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

function ManagedVoiceControls({ hostId, settings, theme, speedProblem, testing, testAction, resetTest }: {
  hostId: string; settings: ReadyVoiceSettings; theme: Theme; speedProblem?: string; testing: boolean;
  testAction: (disabled: boolean) => ReactNode; resetTest: () => void;
}) {
  const getVoices = useRpc(managedVoices);
  const [search, setSearch] = useState("");
  const [voiceRemoved, setVoiceRemoved] = useState(false);
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
  const removed = Boolean(saved.voiceId && !selection.voiceId);
  const { matching, options } = voicePickerOptions(available ?? [], selection.voiceId, search);
  const busy = testing || settings.saving;
  const speedUnavailable = Boolean(speedProblem && selection.speed !== 1);
  const save = (managed: VoiceSettings["managed"]) =>
    settings.save({ ...settings.values, managed }, settings.revision);

  useEffect(() => {
    if (selection !== saved && (!voices.isFetching || saved.voiceId === unavailableVoiceId) &&
        !settings.saving && !settings.saveError) {
      if (removed) setVoiceRemoved(true);
      void settings.save({ ...settings.values, managed: selection }, settings.revision);
    }
  }, [removed, saved, selection, settings, unavailableVoiceId, voices.isFetching]);

  const voiceHint = voices.isFetching && !available ? "Loading voices..."
    : available?.length === 0 ? "No approved voices are available"
    : available && !matching.length ? "No matching voices" : undefined;

  return (
    <SettingsSection title="Google Chirp 3 HD via Central voice">
      <SettingsCard>
        <SettingsInput label="Search by voice name" placeholder="Enter a name" disabled={!available?.length}
          onChangeText={setSearch} />
        <SettingsSelect label="Voice" value={available ? selection.voiceId : ""} options={options}
          hint={voiceHint} disabled={busy || voices.isFetching || !matching.length}
          onValueChange={(voiceId) => {
            const voice = matching.find(({ id }) => id === voiceId);
            if (!voice) return;
            setVoiceRemoved(false);
            resetTest();
            void save({ ...selection, voiceId: voice.id, voiceName: voice.name });
          }} />
        <SettingsAction label="Approved voices" actionLabel={voices.isFetching ? "Refreshing..." : "Refresh"}
          disabled={voices.isFetching} onPress={() => void voices.refetch()} />
        {voices.isError ? <Message theme={theme} text={voices.error.message} error /> : null}
        {voiceRemoved || removed ? <Message theme={theme} text="That voice is no longer available. Choose another approved voice." /> : null}
        <SettingsSelect label="Speed" value={speedUnavailable ? "" : String(selection.speed)}
          options={speedProblem ? SPEEDS.filter(({ value }) => value === "1") : SPEEDS} disabled={busy}
          onValueChange={(value) => {
            const speed = managedSpeed.safeParse(Number(value));
            if (!speed.success || (speedProblem && speed.data !== 1)) return;
            resetTest();
            void save({ ...selection, speed: speed.data });
          }} />
        {speedProblem ? <Message theme={theme} text={speedProblem} /> : null}
        {testAction(busy || voices.isFetching || !selection.voiceId || !available || speedUnavailable)}
      </SettingsCard>
    </SettingsSection>
  );
}

export function createVoiceSettingsScreen(client: PluginClientContext) {
  const preview = createVoicePreview();
  return function VoiceSettingsScreen({ theme, host }: PluginSurfaceProps) {
    const settings = useSettings(voiceSettings);
    const mode = useManagedStatus(host.id);
    const status = mode.isSuccess && mode.isFetchedAfterMount ? mode.data : undefined;
    const speak = useRpc(synthesizeSpeech);
    const queryClient = useQueryClient();
    const state = useSyncExternalStore(preview.subscribe, preview.getSnapshot, preview.getSnapshot);
    const testing = state.status === "playing";

    function testAction(mode: "managed" | "personal", disabled: boolean) {
      return <SettingsAction label="Test voice" actionLabel={testing ? "Testing..." : "Play"}
        disabled={disabled || testing}
        hint={mode === "managed" ? `Plays “${protocol.pilot.fixture_text}”` : undefined}
        error={state.status === "error" ? state.message : undefined}
        onPress={async () => {
          if (disabled) return;
          const result = await preview.play({ mode, speak, playAudio: (audio) => client.playAudio(audio) });
          if (result === "failed" && mode === "managed") {
            void queryClient.invalidateQueries({ queryKey: [...voiceStatusQueryKey, host.id] });
          }
        }} />;
    }

    const personal = status?.mode === "personal";
    const provider = settings.status === "ready" ? settings.values.provider : undefined;
    const options = status ? voiceSources(status.mode) : [];
    const selected = options.some(({ value }) => value === provider) ? provider : undefined;
    const google = personal && settings.status === "ready" && settings.values.provider === "google";

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
                disabled={settings.saving || testing} onValueChange={(provider) => {
                  if (!provider) return;
                  preview.reset();
                  void settings.save({ ...settings.values, provider }, settings.revision);
                }} />
              {!selected && provider === "google" ? <Message theme={theme} text={DIRECT_VOICE_UNAVAILABLE} /> : null}
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
        {google ? <GoogleControls settings={settings} theme={theme} testAction={testAction("personal", settings.saving)} /> : null}
        {status && status.mode !== "personal" && settings.status === "ready" && provider === "managed" ? (
          status.mode === "managed" ? (
            <ManagedVoiceControls hostId={host.id} settings={settings} theme={theme} speedProblem={status.speedProblem}
              testing={testing} testAction={(disabled) => testAction("managed", disabled)} resetTest={preview.reset} />
          ) : (
            <SettingsSection title="Google Chirp 3 HD via Central voice">
              <Message theme={theme} text={status.reason} error />
            </SettingsSection>
          )
        ) : null}
        {personal && settings.status === "ready" && provider === "paseo" ? (
          <SettingsSection title="Preview">
            <SettingsCard>{testAction("personal", settings.saving)}</SettingsCard>
          </SettingsSection>
        ) : null}
        {personal ? <DeviceControls theme={theme} /> : null}
      </>
    );
  };
}
