import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createReadAloudRow } from "./client/read-aloud-row";
import { createVoiceSettingsScreen } from "./client/settings-screen";
import { READ_ALOUD_KIND, readAloudSchema } from "./shared/speech";

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "voice", title: "Read Aloud", icon: "Volume2", Component: createVoiceSettingsScreen(client),
  });
  const removeRenderer = client.addTimelineRenderer({
    kind: READ_ALOUD_KIND,
    version: 1,
    schema: readAloudSchema,
    Component: createReadAloudRow(client),
  });
  return async () => {
    await removeRenderer();
    await removeSettings();
  };
}
