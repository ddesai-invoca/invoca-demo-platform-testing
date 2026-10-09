/* Settings: the customer-facing link for THIS demo — the password-protected address to send a
   customer, the password they use, and the controls (extend, refresh agents, turn off). Internal
   staff only: the customer build has no Settings route. Owner or admin can change it; the server
   enforces that, and anyone else sees the panel report that it did not work. */
import { useDemoLibrary } from "../data/DemoLibraryContext";
import { useProfile } from "../data/ProfileContext";
import { SharePanel } from "../components/SharePanel";

export function CustomerLinkSettings() {
  const { profile } = useProfile();
  const { demos, available } = useDemoLibrary();
  const inLibrary = available && demos.some((d) => d.id === profile.id);
  return (
    <div className="shs-page">
      <h1 className="shs-title">Settings</h1>
      <p className="shs-sub">
        What a customer sees is limited to the Agent Studio workflows (Voice and SMS) with the live Preview agents,
        and the two AI conversation reports. Send them the link and password below.
      </p>
      {inLibrary
        ? <SharePanel key={profile.id} inline demoId={profile.id} prospect={profile.customerName} onClose={() => {}} />
        : <p className="shp-p">This demo is not in the team library yet, so it cannot have a customer link. Publish it from the Launch screen first.</p>}
    </div>
  );
}
