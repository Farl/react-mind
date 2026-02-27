import { EditorShell } from "./components/EditorShell";
import { appConfig } from "./config/env";

export default function App() {
  return <EditorShell appName={appConfig.appName} />;
}
