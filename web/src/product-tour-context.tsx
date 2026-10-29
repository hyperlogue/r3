import { createContext, type ReactNode, useContext, useState } from "react";

type Restart = () => void;
const Context = createContext<{
  restart: Restart | null;
  register: (restart: Restart | null) => void;
} | null>(null);

export function ProductTourProvider({ children }: { children: ReactNode }) {
  const [restart, setRestart] = useState<Restart | null>(null);
  const [register] = useState(() => (next: Restart | null) => setRestart(() => next));
  return <Context value={{ restart, register }}>{children}</Context>;
}
export const useProductTour = () => useContext(Context);
