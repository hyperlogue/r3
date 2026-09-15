import { ArtifactPreview } from "./components/ArtifactPreview.tsx";
import type { ArtifactRenderer } from "./pages/ArtifactView.tsx";

export const renderPublishedPreview: ArtifactRenderer = (props) => <ArtifactPreview {...props} />;
