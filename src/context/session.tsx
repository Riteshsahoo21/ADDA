import { createContext, PropsWithChildren, useContext, useState } from 'react';

type Session = { username: string | null; login: (username: string) => void; logout: () => void };
const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const [username, setUsername] = useState<string | null>('Friend');
  return (
    <SessionContext.Provider value={{ username, login: setUsername, logout: () => setUsername(null) }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('SessionProvider is missing');
  return session;
}
