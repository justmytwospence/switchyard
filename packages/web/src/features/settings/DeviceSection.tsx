import { currentDeviceId, useAuth } from "../../app/auth";
import { useBreakpoint, useCoarsePointer } from "../../app/useBreakpoint";
import { Card } from "../../components/ui/Card";
import { SwitchRow } from "../../components/ui/Switch";
import { usePrefs } from "../../prefs";
import { useSyncStore } from "../../sync/store";
import { DEVICE_KIND_LABEL } from "./DevicesSection";
import { KeyValues, SectionPage } from "./shared";

/** Settings › This device: preferences stored only in this browser. */
export function DeviceSection() {
  const sendWithEnter = usePrefs((s) => s.sendWithEnter);
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
        </div>
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
