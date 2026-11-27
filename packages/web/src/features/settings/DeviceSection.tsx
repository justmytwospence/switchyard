import { currentDeviceId, useAuth } from "../../app/auth";
import { NavigationEditor } from "../../app/NavigationEditor";
import { useBreakpoint, useCoarsePointer } from "../../app/useBreakpoint";
import { Card } from "../../components/ui/Card";
import { RadioCards } from "../../components/ui/RadioCards";
import { SwitchRow } from "../../components/ui/Switch";
import { usePrefs } from "../../prefs";
import { useSyncStore } from "../../sync/store";
import { DEVICE_KIND_LABEL } from "./ClientsSection";
import { KeyValues, SectionPage } from "./shared";

/** Settings › This device: preferences stored only in this browser. */
export function DeviceSection() {
  const sendWithEnter = usePrefs((s) => s.sendWithEnter);
  const transcriptDetail = usePrefs((s) => s.transcriptDetail);
  const followUpMode = usePrefs((s) => s.followUpMode);
  const setPref = usePrefs((s) => s.set);
  const bp = useBreakpoint();
  const coarse = useCoarsePointer();
  useAuth((s) => s.me);
  const id = currentDeviceId();
  const device = useSyncStore((s) => (id ? s.devices[id] : undefined));

  return (
    <SectionPage
      title="This device"
      description="These preferences are stored in this browser only; your other devices keep their own."
    >
      <Card
        title="Navigation"
        description="Which pages the phone's bottom bar shows, and the order of all of them."
        testId="navigation-settings"
      >
        <NavigationEditor />
      </Card>
      <Card title="Composer">
        <div className="flex flex-col gap-3">
          <SwitchRow
            label="Send with Enter"
            description="On desktop, Enter sends the message and Shift+Enter inserts a newline. When off, Enter inserts a newline; send with the Send button."
            checked={sendWithEnter}
            onChange={(v) => setPref("sendWithEnter", v)}
          />
          <p className="text-sm text-muted">
            On mobile, Return always inserts a newline and messages are sent with the Send button.
            {bp === "mobile" || coarse ? " That applies on this device now." : ""}
          </p>
          <RadioCards
            legend="While Pi is working"
            value={followUpMode}
            onChange={(v) => setPref("followUpMode", v)}
            hint="Cmd/Ctrl+Enter, or the + menu, does the other."
            options={[
              {
                value: "queue",
                label: "Queue",
                explanation: "Send queues your message. Pi reads it when the current turn ends.",
              },
              {
                value: "steer",
                label: "Steer",
                explanation:
                  "Send delivers your message now, between Pi's tool calls, when the session supports it.",
              },
            ]}
          />
        </div>
      </Card>
      <Card title="Transcript">
        <RadioCards
          legend="Tool activity"
          value={transcriptDetail}
          onChange={(v) => setPref("transcriptDetail", v)}
          options={[
            {
              value: "detailed",
              label: "Detailed",
              explanation: "Every tool call stays visible as its own line.",
            },
            {
              value: "normal",
              label: "Normal",
              explanation:
                "A finished turn folds its tool calls into one line. The reply always shows.",
            },
            {
              value: "summary",
              label: "Summary",
              explanation: "A running turn folds too: one line that says what Pi is doing.",
            },
          ]}
        />
      </Card>
      <Card title="Identity">
        <KeyValues
          items={[
            ["Name", device?.name ?? "Unknown"],
            ["Kind", device ? DEVICE_KIND_LABEL[device.kind] : "Unknown"],
            [
              "Device ID",
              <span key="id" className="break-all font-mono">
                {id ?? "Unknown"}
              </span>,
            ],
          ]}
        />
      </Card>
    </SectionPage>
  );
}
