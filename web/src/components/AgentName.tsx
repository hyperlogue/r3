import { useQuery } from "@tanstack/react-query";
import { artifactApi } from "../artifact-api.ts";

export function AgentName({ id }: { id: string }) {
  const { data: sessions } = useQuery({
    queryKey: ["agent-sessions"],
    queryFn: () => artifactApi.sessions(),
    staleTime: 60_000,
  });
  return <>{sessions?.find((session) => session.id === id)?.label || id}</>;
}
